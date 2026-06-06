// RoomDurableObject — one instance per room id.
//
// Responsibilities:
//   - persist room metadata + encrypted message envelopes (never plaintext)
//   - verify the access proof (proof-of-possession of the invite secret)
//   - coordinate realtime delivery over WebSockets
//   - sweep expired messages via storage alarms and delete orphaned R2 objects
//   - self-destruct the whole room when its lifetime elapses
//   - enforce basic abuse controls (rate limit, envelope size cap, room cap)
//
// All chat content is opaque to this object. It only ever sees ciphertext and
// operational metadata (ids, timestamps, sizes, verifier hashes).

import { RoomCore, type RoomSnapshot } from "../../shared/roomCore"
import { hashAccessProof } from "../../shared/crypto"
import type {
  BroadcastRequest,
  CreateRoomRequest,
  ListMessagesRequest,
  PostMessageRequest,
  PruneRequest,
  ReactRequest,
  RealtimeFrame,
  SessionRequest,
  UpdateInviteRequest,
  ValidateInviteRequest,
} from "../../shared/types"
import {
  clampRoomLifetime,
  inviteExpiryToMs,
  MAX_ENVELOPE_CHARS,
  MAX_MESSAGES_PER_ROOM,
  MESSAGE_RATE_LIMIT,
  MESSAGE_RATE_WINDOW_MS,
} from "../../shared/constants"

export interface RoomEnv {
  MEDIA: R2Bucket
}

interface Session {
  ws: WebSocket
  participantId: string
}

const SNAPSHOT_KEY = "snapshot"

export class RoomDurableObject {
  private state: DurableObjectState
  private env: RoomEnv
  private core: RoomCore
  private sessions = new Set<Session>()
  // Short-lived signalling frames (typing/seen) buffered so clients on the
  // polling fallback can receive them via the list response. In-memory only.
  private recentSignals: Array<{ at: number; frame: RealtimeFrame }> = []
  // Per-participant send timestamps for rate limiting. In-memory only.
  private rate = new Map<string, number[]>()
  private loaded = false

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state
    this.env = env
    this.core = new RoomCore()
    this.state.blockConcurrencyWhile(async () => {
      const snap = await this.state.storage.get<RoomSnapshot>(SNAPSHOT_KEY)
      if (snap) this.core = new RoomCore(snap)
      this.loaded = true
    })
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(SNAPSHOT_KEY, this.core.toSnapshot())
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.state.blockConcurrencyWhile(async () => {})
  }

  // ---------- routing ----------

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded()
    // Enforce room self-destruct before handling any op, so an expired room
    // behaves as deleted even if the alarm has not fired yet.
    if (await this.enforceLifetime(Date.now())) {
      const url = new URL(request.url)
      if (url.pathname.replace(/^\//, "") === "ws") {
        return new Response("gone", { status: 410 })
      }
    }
    const url = new URL(request.url)
    const op = url.pathname.replace(/^\//, "")

    if (op === "ws") return this.handleWebSocket(request, url)

    let body: Record<string, unknown> = {}
    if (request.method !== "GET") {
      try {
        body = await request.json()
      } catch {
        body = {}
      }
    }

    try {
      switch (op) {
        case "create":
          return this.opCreate(body as unknown as CreateRoomRequest)
        case "validate":
          return this.opValidate(body as unknown as ValidateInviteRequest)
        case "session":
          return this.opSession(body as unknown as SessionRequest)
        case "update":
          return this.opUpdate(body as unknown as UpdateInviteRequest)
        case "message":
          return this.opMessage(body as unknown as PostMessageRequest)
        case "list":
          return this.opList(body as unknown as ListMessagesRequest)
        case "prune":
          return this.opPrune(body as unknown as PruneRequest)
        case "react":
          return this.opReact(body as unknown as ReactRequest)
        case "broadcast":
          return this.opBroadcast(body as unknown as BroadcastRequest)
        case "delete":
          return this.opDelete(body as { accessProof: string })
        default:
          return json({ error: "unknown op" }, 404)
      }
    } catch (err) {
      return json({ error: (err as Error).message || "internal error" }, 500)
    }
  }

  // ---------- proof gate ----------

  private async verifyProof(accessProof: string | undefined): Promise<boolean> {
    if (!accessProof) return false
    const hash = await hashAccessProof(accessProof)
    return this.core.verifyHash(hash)
  }

  // Sliding-window per-participant rate limiter. Best-effort; in-memory only.
  private allowRate(id: string, now: number): boolean {
    const arr = (this.rate.get(id) ?? []).filter((t) => now - t < MESSAGE_RATE_WINDOW_MS)
    if (arr.length >= MESSAGE_RATE_LIMIT) {
      this.rate.set(id, arr)
      return false
    }
    arr.push(now)
    this.rate.set(id, arr)
    return true
  }

  // ---------- operations ----------

  private async opCreate(req: CreateRoomRequest): Promise<Response> {
    const now = Date.now()
    if (!req.roomId || !req.accessProofHash) return json({ error: "missing fields" }, 400)
    this.core.createRoom({
      roomId: req.roomId,
      accessProofHash: req.accessProofHash,
      inviteExpiresAt: inviteExpiryToMs(req.inviteExpiry ?? "never", now),
      ttlMs: req.ttlMs,
      burnAfterRead: req.burnAfterRead,
      roomLifetimeMs: req.roomLifetimeMs,
      now,
    })
    await this.persist()
    // A room with a lifetime needs an alarm even if no message is ever sent.
    await this.scheduleSweep()
    return json({ room: this.core.publicState(now) })
  }

  private async opValidate(req: ValidateInviteRequest): Promise<Response> {
    const now = Date.now()
    const status = this.core.validateInvite(req.accessProofHash ?? "", now)
    return json({ status, room: status === "valid" ? this.core.publicState(now) : undefined })
  }

  private async opSession(req: SessionRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const now = Date.now()
    if (this.core.isInviteExpired(now)) return json({ error: "expired" }, 410)
    this.core.touchParticipant(req.participantId, now)
    await this.persist()
    this.broadcast({ t: "presence", participantCount: this.core.participantCount(now) })
    return json({ room: this.core.publicState(now) })
  }

  private async opUpdate(req: UpdateInviteRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const now = Date.now()
    let destroyAt: number | null | undefined
    if (req.roomLifetimeMs !== undefined) {
      const lifetime = clampRoomLifetime(req.roomLifetimeMs)
      destroyAt = lifetime > 0 ? now + lifetime : null
    }
    const room = this.core.updateRoom({
      inviteExpiresAt:
        req.inviteExpiry !== undefined ? inviteExpiryToMs(req.inviteExpiry, now) : undefined,
      ttlMs: req.ttlMs,
      burnAfterRead: req.burnAfterRead,
      destroyAt,
    })
    if (!room) return json({ error: "not found" }, 404)
    await this.persist()
    await this.scheduleSweep()
    return json({ room: this.core.publicState(now) })
  }

  private async opMessage(req: PostMessageRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const now = Date.now()
    if (this.core.isInviteExpired(now) && req.message.kind !== "system") {
      // Expired invites block new joins/sends but existing data is preserved.
      return json({ error: "expired" }, 410)
    }
    // Abuse controls: cap envelope size and rate-limit per participant.
    if ((req.message.envelope?.length ?? 0) > MAX_ENVELOPE_CHARS) {
      return json({ error: "message too large" }, 413)
    }
    if (!this.allowRate(req.message.participantId, now)) {
      return json({ error: "rate limited" }, 429)
    }
    const message = this.core.addMessage(
      {
        id: req.message.id,
        participantId: req.message.participantId,
        senderSlot: req.message.senderSlot,
        envelope: req.message.envelope,
        media: req.message.media,
        kind: req.message.kind,
        ttlMs: req.message.ttlMs,
        burn: req.message.burn,
      },
      now,
    )
    // Deliver to connected peers immediately, before the storage round-trips
    // (persist + alarm scheduling), so realtime delivery feels instant.
    // Durability follows right after; a crash in the gap at worst drops a
    // single just-sent message, which the sender can resend.
    this.broadcast({ t: "message", message })
    // Rolling per-room cap: prune the oldest messages beyond the ceiling.
    const all = this.core.list(now)
    if (all.length > MAX_MESSAGES_PER_ROOM) {
      const overflow = all.slice(0, all.length - MAX_MESSAGES_PER_ROOM).map((m) => m.id)
      const pr = this.core.prune(overflow)
      if (pr.orphanObjectKeys.length) await this.deleteObjects(pr.orphanObjectKeys)
      if (pr.removedIds.length) this.broadcast({ t: "prune", messageIds: pr.removedIds })
    }
    await this.persist()
    await this.scheduleSweep()
    return json({ message })
  }

  private async opList(req: ListMessagesRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const now = Date.now()
    const swept = this.core.sweep(now)
    if (swept.orphanObjectKeys.length) await this.deleteObjects(swept.orphanObjectKeys)
    let messages = this.core.list(now)
    if (typeof req.since === "number") messages = messages.filter((m) => m.createdAt > req.since!)

    // burn-after-read: mark read for this reader (removes others' burn msgs)
    if (req.markReadFor) {
      const { burnedIds, orphanObjectKeys } = this.core.markRead(req.markReadFor, now)
      if (burnedIds.length) {
        await this.persist()
        if (orphanObjectKeys.length) await this.deleteObjects(orphanObjectKeys)
        this.broadcast({ t: "prune", messageIds: burnedIds })
      }
    }
    const signalsSince = typeof req.signalsSince === "number" ? req.signalsSince : now
    const signals = this.recentSignals.filter((s) => s.at > signalsSince).map((s) => s.frame)
    return json({ messages, room: this.core.publicState(now), serverTime: now, signals })
  }

  private async opPrune(req: PruneRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const result = req.all ? this.core.pruneAll() : this.core.prune(req.messageIds ?? [])
    await this.persist()
    if (result.orphanObjectKeys.length) await this.deleteObjects(result.orphanObjectKeys)
    this.broadcast({ t: "prune", messageIds: result.removedIds, all: req.all })
    return json({ removedIds: result.removedIds })
  }

  private async opReact(req: ReactRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const m = this.core.setReaction({
      messageId: req.messageId,
      reactionId: req.reactionId,
      participantId: req.participantId,
      envelope: req.envelope,
    })
    if (!m) return json({ error: "not found" }, 404)
    // Broadcast first for snappy delivery; persist the updated state after.
    this.broadcast({
      t: "react",
      messageId: req.messageId,
      reactionId: req.reactionId,
      participantId: req.participantId,
      envelope: req.envelope,
    })
    await this.persist()
    return json({ ok: true })
  }

  private async opBroadcast(req: BroadcastRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const frame: RealtimeFrame = { t: "signal", event: req.event }
    this.broadcast(frame)
    this.recordSignal(frame)
    return json({ ok: true })
  }

  private async opDelete(req: { accessProof: string }): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    const now = Date.now()
    await this.destroyRoom(now)
    return json({ ok: true })
  }

  // ---------- realtime ----------

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 })
    }
    const accessProof = url.searchParams.get("p") ?? ""
    const participantId = url.searchParams.get("u") ?? "anon"
    if (!(await this.verifyProof(accessProof))) {
      return new Response("forbidden", { status: 403 })
    }
    const now = Date.now()
    if (this.core.isInviteExpired(now)) return new Response("expired", { status: 410 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    const session: Session = { ws: server, participantId }
    this.sessions.add(session)
    this.core.touchParticipant(participantId, now)

    server.addEventListener("message", (event: MessageEvent) => {
      this.onClientFrame(session, event.data)
    })
    const drop = () => {
      this.sessions.delete(session)
      this.broadcast({ t: "presence", participantCount: this.core.participantCount(Date.now()) })
    }
    server.addEventListener("close", drop)
    server.addEventListener("error", drop)

    this.send(session, { t: "hello", serverTime: now, participantCount: this.core.participantCount(now) })
    this.broadcast({ t: "presence", participantCount: this.core.participantCount(now) })

    return new Response(null, { status: 101, webSocket: client })
  }

  // Client frames are opaque signalling (typing/presence/seen). Content stays
  // encrypted; we just relay envelopes between peers.
  private onClientFrame(session: Session, raw: string | ArrayBuffer): void {
    let frame: RealtimeFrame | null = null
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
    } catch {
      return
    }
    if (!frame) return
    const now = Date.now()
    this.core.touchParticipant(session.participantId, now)
    if (frame.t === "signal" || frame.t === "seen") {
      this.broadcast(frame, session)
      this.recordSignal(frame)
    }
  }

  // Buffer a signalling frame for polling clients; ephemeral, capped, and
  // pruned to the last 15s so stale typing never replays.
  private recordSignal(frame: RealtimeFrame): void {
    const at = Date.now()
    this.recentSignals.push({ at, frame })
    const cutoff = at - 15000
    this.recentSignals = this.recentSignals.filter((s) => s.at > cutoff).slice(-100)
  }

  private send(session: Session, frame: RealtimeFrame): void {
    try {
      session.ws.send(JSON.stringify(frame))
    } catch {
      this.sessions.delete(session)
    }
  }

  private broadcast(frame: RealtimeFrame, except?: Session): void {
    const data = JSON.stringify(frame)
    for (const s of this.sessions) {
      if (s === except) continue
      try {
        s.ws.send(data)
      } catch {
        this.sessions.delete(s)
      }
    }
  }

  // ---------- expiry alarm ----------

  private async scheduleSweep(): Promise<void> {
    const next = this.core.nextExpiry()
    if (next === null) return
    const existing = await this.state.storage.getAlarm()
    if (existing === null || next < existing) {
      await this.state.storage.setAlarm(Math.max(next, Date.now() + 1000))
    }
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded()
    const now = Date.now()
    // Whole-room self-destruct takes priority over per-message sweeps.
    if (await this.enforceLifetime(now)) return
    const swept = this.core.sweep(now)
    if (swept.removedIds.length) {
      await this.persist()
      if (swept.orphanObjectKeys.length) await this.deleteObjects(swept.orphanObjectKeys)
      this.broadcast({ t: "prune", messageIds: swept.removedIds })
    }
    await this.scheduleSweep()
  }

  /** If the room has passed its self-destruct time, wipe it. Returns true if so. */
  private async enforceLifetime(now: number): Promise<boolean> {
    if (!this.core.isRoomDestroyed(now)) return false
    await this.destroyRoom(now)
    return true
  }

  /** Tear down the room: clear data, delete R2 objects, notify and drop clients. */
  private async destroyRoom(now: number): Promise<void> {
    const keys = this.core.deleteRoom(now)
    await this.persist()
    await this.deleteAllRoomObjects()
    if (keys.length) await this.deleteObjects(keys)
    this.broadcast({ t: "room-deleted" })
    for (const s of this.sessions) {
      try {
        s.ws.close(1000, "room closed")
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear()
  }

  // ---------- R2 cleanup ----------

  private async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length || !this.env.MEDIA) return
    try {
      await this.env.MEDIA.delete(keys)
    } catch {
      /* best effort */
    }
  }

  private async deleteAllRoomObjects(): Promise<void> {
    const room = this.core.getRoom()
    if (!room || !this.env.MEDIA) return
    const prefix = `rooms/${room.roomId}/`
    try {
      let cursor: string | undefined
      do {
        const listed = await this.env.MEDIA.list({ prefix, cursor })
        const keys = listed.objects.map((o) => o.key)
        if (keys.length) await this.env.MEDIA.delete(keys)
        cursor = listed.truncated ? listed.cursor : undefined
      } while (cursor)
    } catch {
      /* best effort */
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
