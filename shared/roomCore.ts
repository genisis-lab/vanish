// Pure, platform-agnostic room logic. No Cloudflare or DOM dependencies so it
// can be unit-tested directly and reused by the Durable Object as its source of
// truth. The Durable Object is a thin persistence + realtime wrapper around it.

import { clampTtl, DEFAULT_MESSAGE_TTL_MS } from "./constants"
import type {
  EncryptedMediaRef,
  MessageKind,
  PublicRoomState,
  StoredMessage,
} from "./types"

export interface RoomRecord {
  roomId: string
  /** SHA-256(accessProof) \u2014 the verifier. The raw proof is never stored. */
  accessProofHash: string
  inviteExpiresAt: number | null
  defaultTtlMs: number
  burnAfterRead: boolean
  createdAt: number
  deletedAt: number | null
}

export interface RoomSnapshot {
  room: RoomRecord | null
  messages: StoredMessage[]
  participants: Record<string, number> // participantId -> lastSeen
}

export interface AddMessageInput {
  id: string
  participantId: string
  senderSlot?: string | null
  envelope: string
  media?: EncryptedMediaRef[]
  kind: MessageKind
  ttlMs?: number
  burn?: boolean
}

export interface SweepResult {
  removedIds: string[]
  /** R2 object keys whose backing bytes should now be deleted. */
  orphanObjectKeys: string[]
}

export class RoomCore {
  private room: RoomRecord | null
  private messages: Map<string, StoredMessage>
  private participants: Map<string, number>

  constructor(snapshot?: Partial<RoomSnapshot>) {
    this.room = snapshot?.room ?? null
    this.messages = new Map((snapshot?.messages ?? []).map((m) => [m.id, m]))
    this.participants = new Map(Object.entries(snapshot?.participants ?? {}))
  }

  // ---------- room lifecycle ----------

  exists(): boolean {
    return this.room !== null && this.room.deletedAt === null
  }

  getRoom(): RoomRecord | null {
    return this.room
  }

  createRoom(input: {
    roomId: string
    accessProofHash: string
    inviteExpiresAt: number | null
    ttlMs?: number
    burnAfterRead?: boolean
    now: number
  }): RoomRecord {
    if (this.room && this.room.deletedAt === null) {
      // Idempotent create: a room with this id already exists. Keep it.
      return this.room
    }
    this.room = {
      roomId: input.roomId,
      accessProofHash: input.accessProofHash,
      inviteExpiresAt: input.inviteExpiresAt,
      defaultTtlMs: clampTtl(input.ttlMs, DEFAULT_MESSAGE_TTL_MS),
      burnAfterRead: input.burnAfterRead ?? false,
      createdAt: input.now,
      deletedAt: null,
    }
    this.messages.clear()
    this.participants.clear()
    return this.room
  }

  /** Verify a hashed access proof against the stored verifier. */
  verifyHash(accessProofHash: string): boolean {
    if (!this.room || this.room.deletedAt !== null) return false
    return timingSafeEqual(this.room.accessProofHash, accessProofHash)
  }

  isInviteExpired(now: number): boolean {
    return !!this.room?.inviteExpiresAt && this.room.inviteExpiresAt <= now
  }

  /** Existence/validity check for the invite-validation endpoint. */
  validateInvite(
    accessProofHash: string,
    now: number,
  ): "valid" | "invalid" | "expired" | "deleted" {
    if (!this.room) return "invalid"
    if (this.room.deletedAt !== null) return "deleted"
    if (!this.verifyHash(accessProofHash)) return "invalid"
    if (this.isInviteExpired(now)) return "expired"
    return "valid"
  }

  updateRoom(input: {
    inviteExpiresAt?: number | null
    ttlMs?: number
    burnAfterRead?: boolean
  }): RoomRecord | null {
    if (!this.room || this.room.deletedAt !== null) return null
    if (input.inviteExpiresAt !== undefined) this.room.inviteExpiresAt = input.inviteExpiresAt
    if (input.ttlMs !== undefined) this.room.defaultTtlMs = clampTtl(input.ttlMs, this.room.defaultTtlMs)
    if (input.burnAfterRead !== undefined) this.room.burnAfterRead = input.burnAfterRead
    return this.room
  }

  deleteRoom(now: number): string[] {
    const orphanKeys = this.allObjectKeys()
    if (this.room) this.room.deletedAt = now
    this.messages.clear()
    this.participants.clear()
    return orphanKeys
  }

  // ---------- participants ----------

  touchParticipant(participantId: string, now: number): void {
    this.participants.set(participantId, now)
  }

  participantCount(now: number, windowMs = 45 * 1000): number {
    let count = 0
    for (const lastSeen of this.participants.values()) {
      if (now - lastSeen <= windowMs) count++
    }
    return count
  }

  // ---------- messages ----------

  addMessage(input: AddMessageInput, now: number): StoredMessage {
    if (!this.room || this.room.deletedAt !== null) throw new Error("room not available")
    const burn = input.burn ?? this.room.burnAfterRead
    const ttl = clampTtl(input.ttlMs, this.room.defaultTtlMs)
    const message: StoredMessage = {
      id: input.id,
      roomId: this.room.roomId,
      participantId: input.participantId,
      senderSlot: input.senderSlot ?? null,
      envelope: input.envelope,
      media: input.media,
      kind: input.kind,
      createdAt: now,
      expiresAt: burn ? null : now + ttl,
      burn,
    }
    this.messages.set(message.id, message)
    this.touchParticipant(input.participantId, now)
    return message
  }

  list(now: number): StoredMessage[] {
    this.sweep(now)
    return [...this.messages.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Mark burn-after-read messages consumed by a reader who is not the author.
   * They are removed after this delivery. Returns object keys to free.
   */
  markRead(readerId: string, now: number): { burnedIds: string[]; orphanObjectKeys: string[] } {
    const burnedIds: string[] = []
    const orphanObjectKeys: string[] = []
    for (const m of this.messages.values()) {
      if (m.burn && m.participantId !== readerId) {
        burnedIds.push(m.id)
        for (const ref of m.media ?? []) orphanObjectKeys.push(ref.objectKey)
        this.messages.delete(m.id)
      }
    }
    void now
    return { burnedIds, orphanObjectKeys }
  }

  setReaction(input: {
    messageId: string
    reactionId: string
    participantId: string
    envelope: string | null
  }): StoredMessage | null {
    const m = this.messages.get(input.messageId)
    if (!m) return null
    m.reactions = m.reactions ?? {}
    if (input.envelope === null) {
      delete m.reactions[input.reactionId]
    } else {
      m.reactions[input.reactionId] = { participantId: input.participantId, envelope: input.envelope }
    }
    return m
  }

  prune(messageIds: string[]): { removedIds: string[]; orphanObjectKeys: string[] } {
    const removedIds: string[] = []
    const orphanObjectKeys: string[] = []
    for (const id of messageIds) {
      const m = this.messages.get(id)
      if (!m) continue
      for (const ref of m.media ?? []) orphanObjectKeys.push(ref.objectKey)
      this.messages.delete(id)
      removedIds.push(id)
    }
    return { removedIds, orphanObjectKeys }
  }

  pruneAll(): { removedIds: string[]; orphanObjectKeys: string[] } {
    return this.prune([...this.messages.keys()])
  }

  /** Remove expired messages. Returns ids removed and R2 keys to delete. */
  sweep(now: number): SweepResult {
    const removedIds: string[] = []
    const orphanObjectKeys: string[] = []
    for (const m of this.messages.values()) {
      if (m.expiresAt !== null && m.expiresAt <= now) {
        for (const ref of m.media ?? []) orphanObjectKeys.push(ref.objectKey)
        this.messages.delete(m.id)
        removedIds.push(m.id)
      }
    }
    return { removedIds, orphanObjectKeys }
  }

  /** Next timestamp the room should wake up to sweep, or null if nothing pending. */
  nextExpiry(): number | null {
    let next: number | null = null
    for (const m of this.messages.values()) {
      if (m.expiresAt !== null && (next === null || m.expiresAt < next)) next = m.expiresAt
    }
    return next
  }

  allObjectKeys(): string[] {
    const keys: string[] = []
    for (const m of this.messages.values()) {
      for (const ref of m.media ?? []) keys.push(ref.objectKey)
    }
    return keys
  }

  // ---------- serialization ----------

  toSnapshot(): RoomSnapshot {
    return {
      room: this.room,
      messages: [...this.messages.values()],
      participants: Object.fromEntries(this.participants),
    }
  }

  publicState(now: number): PublicRoomState | null {
    if (!this.room) return null
    return {
      roomId: this.room.roomId,
      createdAt: this.room.createdAt,
      deletedAt: this.room.deletedAt,
      inviteExpiresAt: this.room.inviteExpiresAt,
      defaultTtlMs: this.room.defaultTtlMs,
      burnAfterRead: this.room.burnAfterRead,
      participantCount: this.participantCount(now),
    }
  }
}

// Constant-time-ish string comparison to avoid leaking verifier bytes via timing.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
