// Realtime transport: a WebSocket to the room's Durable Object with automatic
// reconnect and a polling fallback when the socket is unavailable. All frames
// are opaque to the server; signalling payloads are encrypted with the channel
// key before they are sent.
//
// Staying in sync: the transport keeps a cursor, the server time up to which
// this device has every message and change. A sync asks the server for what
// changed after the cursor (reaching back a little, so a change stamped in the
// same millisecond can't slip through) and then moves the cursor to the server
// time of the answer. Syncs run on first load, on every poll while the socket
// is down, and each time the socket (re)connects or the page comes back, to
// fetch what happened in between. Writes this device makes itself never move
// the cursor: a message someone else sent a moment earlier must still arrive.
import type { PublicRoomState, RealtimeFrame, StoredMessage } from "@shared/types"
import { api, ApiError } from "./api"
import type { RoomSession } from "./session"

export type ConnState = "connecting" | "live" | "polling" | "closed"

/** How far before the cursor each sync reaches back. */
export const SYNC_OVERLAP_MS = 500
/** Back in the foreground after this long: open a fresh socket, the old one may be dead. */
export const RESUME_RECONNECT_MS = 30_000
// A sync that finds messages still missing asks again, but not forever.
const MAX_FOLLOW_UPS = 3

export interface SyncBatch {
  /** Messages created or changed after the requested time. */
  messages: StoredMessage[]
  /** Every message id the room holds right now, oldest first, when the server sends it. */
  currentMessageIds?: string[]
  /** Server time the answer was put together. */
  serverTime: number
}

export interface RealtimeHandlers {
  /** A new message arrived over the socket. */
  onMessage: (m: StoredMessage) => void
  /** A message changed (edit, delete) over the socket. */
  onEdit: (m: StoredMessage) => void
  onPrune: (ids: string[], all?: boolean) => void
  onReact: (f: Extract<RealtimeFrame, { t: "react" }>) => void
  /** `left` names participants who just dropped out, when the server knows. */
  onPresence: (count: number, left?: string[]) => void
  onSignal: (f: Extract<RealtimeFrame, { t: "signal" }>) => void
  onSeen: (participantId: string, lastSeen: number, messageIds?: string[]) => void
  onRoomUpdated: (room: PublicRoomState) => void
  /** Messages whose countdown was cleared (chat switched to "never" and kept them). */
  onKept: (messageIds: string[]) => void
  onBanned: (participantId: string) => void
  onRoomDeleted: () => void
  onState: (s: ConnState) => void
  /**
   * Apply the answer to a sync. Returns the time to fetch again from when the
   * server holds messages this device is missing, or null when none are.
   */
  onSync: (batch: SyncBatch) => number | null
  /** A sync failed. The transport keeps retrying on its own. */
  onSyncError?: (error: unknown) => void
}

export class Realtime {
  private session: RoomSession
  private handlers: RealtimeHandlers
  private ws: WebSocket | null = null
  private pollTimer: number | null = null
  private reconnectTimer: number | null = null
  private handshakeTimer: number | null = null
  private syncTimer: number | null = null
  private attempts = 0
  // Nothing runs until start(): the room session must be registered first.
  private stopped = true
  private state: ConnState = "connecting"
  // Server time up to which this device has every message and change; 0 means
  // nothing has loaded yet, so the next sync fetches the whole history.
  private cursor = 0
  // Fetch from here on the next sync instead, after a sync found a gap.
  private rewindTo: number | null = null
  // Bumped on every socket open. Live frames move the cursor only once a sync
  // that started on the current socket has covered the time it was away.
  private socketGen = 0
  private caughtUpGen = -1
  private syncing = false
  private syncQueued = false
  private syncFailures = 0
  private followUps = 0
  // Server time of the newest buffered typing/seen frame already fetched; null
  // until the first sync, which skips stale typing from before we arrived.
  private signalsSince: number | null = null
  // Room settings from the last sync, so a sync only re-applies the room state
  // (timer, topic, bans) when something other than presence changed.
  private syncedRoomKey = ""
  // Counts of live room/presence frames, so an answer the server put together
  // before one of them can't undo it.
  private roomFrames = 0
  private presenceFrames = 0

  constructor(session: RoomSession, handlers: RealtimeHandlers) {
    this.session = session
    this.handlers = handlers
  }

  start(): void {
    this.stopped = false
    this.connect()
    // Load history straight away; the socket connects alongside.
    void this.sync()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.setState("closed")
  }

  /**
   * The page is visible again or the network came back. Catch up on anything
   * missed, and after a long absence replace the socket: phones often keep a
   * dead one looking open after the app was in the background.
   */
  resume(awayForMs = 0): void {
    if (this.stopped) return
    if (this.state === "live" && awayForMs >= RESUME_RECONNECT_MS && this.ws) {
      // onclose switches to polling (which syncs at once) and reconnects.
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      return
    }
    void this.sync()
  }

  private setState(s: ConnState): void {
    if (this.state !== s) {
      this.state = s
      this.handlers.onState(s)
    }
  }

  private wsUrl(): string {
    // Built from runtime location (not a literal) so it works on any origin.
    // Only the (non-secret) room id rides in the URL now; the proofs go in the
    // WebSocket subprotocol so they never land in CDN/proxy/access logs.
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const params = new URLSearchParams({ room: this.session.invite.roomId })
    return proto + "://" + location.host + "/api/ws?" + params.toString()
  }

  // Proofs are sent as WebSocket subprotocol tokens (carried in a request
  // header) instead of query params. Order is positional; the server reads by
  // index and echoes "vanish.v1" back to complete the handshake. base64url
  // values are already token-safe, but we encode defensively and decode
  // symmetrically on the server.
  private wsProtocols(): string[] {
    return [
      "vanish.v1",
      encodeURIComponent(this.session.keys.accessProof),
      encodeURIComponent(this.session.participantId),
      encodeURIComponent(this.session.participantProof),
    ]
  }

  private connect(): void {
    if (this.stopped) return
    this.setState(this.attempts === 0 ? "connecting" : this.state)
    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl(), this.wsProtocols())
    } catch {
      this.fallbackToPolling()
      return
    }
    this.ws = ws
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (ws.readyState !== WebSocket.OPEN) ws.close()
    }, 5_000) as unknown as number

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.clearHandshakeTimer()
      this.attempts = 0
      this.stopPolling()
      this.socketGen++
      this.setState("live")
      // The socket only carries what happens from now on. Fetch whatever was
      // sent while it was connecting or away.
      void this.sync()
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let frame: RealtimeFrame
      try {
        frame = JSON.parse(ev.data as string)
      } catch {
        return
      }
      this.onLiveFrame(frame)
    }
    ws.onclose = () => {
      this.clearHandshakeTimer()
      if (this.ws !== ws) return
      this.ws = null
      if (!this.stopped) this.fallbackToPolling()
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* onclose handles reconnect */
      }
    }
  }

  private onLiveFrame(frame: RealtimeFrame): void {
    switch (frame.t) {
      case "message":
      case "edit": {
        // The socket delivers in order, so once a sync has covered the time
        // before it connected, everything up to this frame has arrived.
        if (this.caughtUpGen === this.socketGen) {
          const m = frame.message
          this.cursor = Math.max(this.cursor, m.updatedAt ?? m.createdAt)
        }
        break
      }
      case "room-updated":
        this.roomFrames++
        this.syncedRoomKey = roomKey(frame.room)
        break
      case "presence":
      case "hello":
        this.presenceFrames++
        break
    }
    this.dispatch(frame)
  }

  private dispatch(frame: RealtimeFrame): void {
    switch (frame.t) {
      case "message":
        this.handlers.onMessage(frame.message)
        break
      case "edit":
        this.handlers.onEdit(frame.message)
        break
      case "prune":
        this.handlers.onPrune(frame.messageIds, frame.all)
        break
      case "react":
        this.handlers.onReact(frame)
        break
      case "presence":
        this.handlers.onPresence(frame.participantCount, frame.left)
        break
      case "hello":
        this.handlers.onPresence(frame.participantCount)
        break
      case "signal":
        this.handlers.onSignal(frame)
        break
      case "seen":
        this.handlers.onSeen(frame.participantId, frame.lastSeen, frame.messageIds)
        break
      case "room-updated":
        this.handlers.onRoomUpdated(frame.room)
        break
      case "kept":
        this.handlers.onKept(frame.messageIds)
        break
      case "banned":
        this.handlers.onBanned(frame.participantId)
        break
      case "room-deleted":
        this.handlers.onRoomDeleted()
        break
    }
  }

  // Send an opaque signalling frame (typing/seen). Best-effort over WS, ignored
  // when offline.
  sendSignal(frame: RealtimeFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(frame))
      } catch {
        /* ignore */
      }
    } else if (frame.t === "signal") {
      // Fall back to the HTTP broadcast relay when the socket is down.
      void api
        .broadcast({
          roomId: this.session.invite.roomId,
          accessProof: this.session.keys.accessProof,
          participantId: this.session.participantId,
          participantProof: this.session.participantProof,
          event: frame.event,
        })
        .catch(() => {})
    }
  }

  // One round trip that brings this device up to date: new and changed
  // messages since the cursor, the room's full id list (to drop what was
  // removed and spot anything missing), buffered typing/seen frames, presence
  // and room settings. Only one runs at a time; asking during one queues
  // another straight after it.
  private async sync(): Promise<void> {
    if (this.stopped) return
    if (this.syncing) {
      this.syncQueued = true
      return
    }
    this.clearSyncTimer()
    this.syncing = true
    this.syncQueued = false
    const rewind = this.rewindTo
    this.rewindTo = null
    const since = rewind ?? (this.cursor > 0 ? Math.max(0, this.cursor - SYNC_OVERLAP_MS) : undefined)
    const gen = this.ws?.readyState === WebSocket.OPEN ? this.socketGen : -1
    const roomFrames = this.roomFrames
    const presenceFrames = this.presenceFrames
    let failed = false
    try {
      const res = await api.listMessages({
        roomId: this.session.invite.roomId,
        accessProof: this.session.keys.accessProof,
        participantId: this.session.participantId,
        participantProof: this.session.participantProof,
        since,
        signalsSince: this.signalsSince ?? undefined,
      })
      if (this.stopped) return
      this.cursor = Math.max(this.cursor, res.serverTime)
      if (gen !== -1 && gen === this.socketGen) this.caughtUpGen = gen
      const missingFrom = this.handlers.onSync({
        messages: res.messages,
        currentMessageIds: res.currentMessageIds,
        serverTime: res.serverTime,
      })
      if (missingFrom === null) {
        this.followUps = 0
      } else if (this.followUps < MAX_FOLLOW_UPS) {
        this.followUps++
        this.rewindTo = Math.min(this.rewindTo ?? missingFrom, missingFrom)
        this.syncQueued = true
      }
      // Deliver buffered signalling frames (typing/seen) that arrived while we
      // were polling instead of holding a live socket. A catch-up on an open
      // socket skips typing: those frames are seconds old or already shown.
      for (const f of res.signals ?? []) {
        if (gen !== -1 && f.t === "signal" && f.event.type === "typing") continue
        this.dispatch(f)
      }
      this.signalsSince = Math.max(this.signalsSince ?? 0, res.serverTime)
      if (presenceFrames === this.presenceFrames) {
        this.handlers.onPresence(res.room.participantCount)
      }
      // Without a socket there are no "room-updated" frames, so pick up timer
      // and topic changes from the synced room state instead.
      const key = roomKey(res.room)
      if (roomFrames === this.roomFrames && key !== this.syncedRoomKey) {
        this.syncedRoomKey = key
        this.handlers.onRoomUpdated(res.room)
      }
      this.syncFailures = 0
    } catch (error) {
      if (this.stopped) return
      if (error instanceof ApiError && error.status === 410) {
        this.handlers.onRoomDeleted()
        this.stop()
        return
      }
      // The gap this sync was meant to fill is still open.
      if (rewind !== null) this.rewindTo = Math.min(this.rewindTo ?? rewind, rewind)
      this.syncFailures++
      failed = true
      this.handlers.onSyncError?.(error)
    } finally {
      this.syncing = false
    }
    if (this.stopped) return
    if (failed) {
      // Polling retries every second anyway; otherwise back off and retry.
      if (this.pollTimer === null) {
        this.scheduleSync(Math.min(30_000, 1000 * 2 ** Math.min(this.syncFailures - 1, 5)))
      }
    } else if (this.syncQueued) {
      this.scheduleSync(0)
    }
  }

  private scheduleSync(delayMs: number): void {
    if (this.stopped || this.syncTimer !== null) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.sync()
    }, delayMs) as unknown as number
  }

  private fallbackToPolling(): void {
    if (this.stopped) return
    this.setState("polling")
    this.startPolling()
    this.scheduleReconnect()
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return
    // 1s cadence keeps fallback delivery snappy when the socket is unavailable.
    // A tick that finds the previous poll still running is skipped, not queued.
    this.pollTimer = setInterval(() => {
      if (!this.syncing) void this.sync()
    }, 1000) as unknown as number
    void this.sync()
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    const delay = Math.min(15000, 1000 * 2 ** this.attempts)
    this.attempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay) as unknown as number
  }

  private clearSyncTimer(): void {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
  }

  private clearTimers(): void {
    this.stopPolling()
    this.clearHandshakeTimer()
    this.clearSyncTimer()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }
}

// Everything in the room state except the live participant count.
function roomKey(room: PublicRoomState): string {
  const { participantCount: _count, ...settings } = room
  void _count
  return JSON.stringify(settings)
}
