// Realtime transport: a WebSocket to the room's Durable Object with automatic
// reconnect and a polling fallback when the socket is unavailable. All frames
// are opaque to the server; signalling payloads are encrypted with the channel
// key before they are sent.
import type { RealtimeFrame, StoredMessage } from "@shared/types"
import { api } from "./api"
import type { RoomSession } from "./session"

export type ConnState = "connecting" | "live" | "polling" | "closed"

export interface RealtimeHandlers {
  onMessage: (m: StoredMessage) => void
  onEdit: (m: StoredMessage) => void
  onPrune: (ids: string[], all?: boolean) => void
  onReact: (f: Extract<RealtimeFrame, { t: "react" }>) => void
  onPresence: (count: number) => void
  onSignal: (f: Extract<RealtimeFrame, { t: "signal" }>) => void
  onSeen: (participantId: string, lastSeen: number) => void
  onRoomDeleted: () => void
  onState: (s: ConnState) => void
  /** Newest message timestamp the UI already has, for polling/catch-up. */
  getSince: () => number
}

export class Realtime {
  private session: RoomSession
  private handlers: RealtimeHandlers
  private ws: WebSocket | null = null
  private pollTimer: number | null = null
  private reconnectTimer: number | null = null
  private attempts = 0
  private stopped = false
  private state: ConnState = "connecting"
  private signalsSince = 0

  constructor(session: RoomSession, handlers: RealtimeHandlers) {
    this.session = session
    this.handlers = handlers
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.setState("closed")
  }

  private setState(s: ConnState): void {
    if (this.state !== s) {
      this.state = s
      this.handlers.onState(s)
    }
  }

  private wsUrl(): string {
    // Built from runtime location (not a literal) so it works on any origin.
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const params = new URLSearchParams({
      room: this.session.invite.roomId,
      p: this.session.keys.accessProof,
      u: this.session.participantId,
    })
    return proto + "://" + location.host + "/api/ws?" + params.toString()
  }

  private connect(): void {
    if (this.stopped) return
    this.setState(this.attempts === 0 ? "connecting" : this.state)
    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl())
    } catch {
      this.fallbackToPolling()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.stopPolling()
      this.setState("live")
    }
    ws.onmessage = (ev) => {
      let frame: RealtimeFrame
      try {
        frame = JSON.parse(ev.data as string)
      } catch {
        return
      }
      this.dispatch(frame)
    }
    ws.onclose = () => {
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
        this.handlers.onPresence(frame.participantCount)
        break
      case "hello":
        this.handlers.onPresence(frame.participantCount)
        break
      case "signal":
        this.handlers.onSignal(frame)
        break
      case "seen":
        this.handlers.onSeen(frame.participantId, frame.lastSeen)
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
          event: frame.event,
        })
        .catch(() => {})
    }
  }

  private fallbackToPolling(): void {
    if (this.stopped) return
    this.setState("polling")
    this.startPolling()
    this.scheduleReconnect()
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return
    // Don't replay typing/signals that predate the moment we started polling.
    if (this.signalsSince === 0) this.signalsSince = Date.now()
    const poll = async () => {
      if (this.stopped) return
      try {
        const res = await api.listMessages({
          roomId: this.session.invite.roomId,
          accessProof: this.session.keys.accessProof,
          since: this.handlers.getSince(),
          signalsSince: this.signalsSince,
          markReadFor: this.session.participantId,
        })
        for (const m of res.messages) this.handlers.onMessage(m)
        // Deliver buffered signalling frames (typing/seen) that arrived while we
        // were polling instead of holding a live socket.
        if (res.signals) for (const f of res.signals) this.dispatch(f)
        this.signalsSince = res.serverTime
        this.handlers.onPresence(res.room.participantCount)
      } catch {
        /* keep trying */
      }
    }
    // 1s cadence keeps fallback delivery snappy when the socket is unavailable.
    this.pollTimer = setInterval(poll, 1000) as unknown as number
    void poll()
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

  private clearTimers(): void {
    this.stopPolling()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
