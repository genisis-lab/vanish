// Pure, platform-agnostic room logic. No Cloudflare or DOM dependencies so it
// can be unit-tested directly and reused by the Durable Object as its source of
// truth. The Durable Object is a thin persistence + realtime wrapper around it.

import { clampRoomLifetime, clampTtl, DEFAULT_MESSAGE_TTL_MS } from "./constants"
import type {
  EncryptedMediaRef,
  MessageKind,
  PublicRoomState,
  StoredMessage,
} from "./types"

export interface RoomRecord {
  roomId: string
  /** SHA-256(accessProof) — the verifier. The raw proof is never stored. */
  accessProofHash: string
  inviteExpiresAt: number | null
  defaultTtlMs: number
  burnAfterRead: boolean
  createdAt: number
  deletedAt: number | null
  /** When set, the whole room self-destructs at this timestamp. */
  destroyAt: number | null
  /** SHA-256(ownerSecret) verifier for owner controls. null = no owner registered. */
  ownerKeyHash: string | null
  /** Opaque encrypted room topic/name envelope, or null. */
  topicEnvelope: string | null
  /** Participant ids the owner has banned from the room. */
  banned: string[]
  /** IP addresses the owner has banned from the room. */
  ipBanned: string[]
}

export interface ParticipantRecord {
  lastSeen: number
  /** SHA-256(participantProof); absent only for pre-upgrade legacy presence rows. */
  proofHash?: string
  /** Last recorded connecting IP address for this participant. */
  ip?: string
}

export interface RoomSnapshot {
  room: RoomRecord | null
  messages: StoredMessage[]
  participants: Record<string, number | ParticipantRecord> // legacy number => lastSeen
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
  private participants: Map<string, ParticipantRecord>

  constructor(snapshot?: Partial<RoomSnapshot>) {
    this.room = snapshot?.room ?? null
    // Backfill fields for rooms persisted before they existed (backward compat).
    if (this.room) {
      if (this.room.destroyAt === undefined) this.room.destroyAt = null
      if (this.room.ownerKeyHash === undefined) this.room.ownerKeyHash = null
      if (this.room.topicEnvelope === undefined) this.room.topicEnvelope = null
      if (this.room.banned === undefined) this.room.banned = []
      if (this.room.ipBanned === undefined) this.room.ipBanned = []
    }
    this.messages = new Map((snapshot?.messages ?? []).map((m) => [m.id, m]))
    this.participants = new Map(
      Object.entries(snapshot?.participants ?? {}).map(([id, value]) => [
        id,
        typeof value === "number" ? { lastSeen: value } : value,
      ]),
    )
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
    roomLifetimeMs?: number
    ownerKeyHash?: string | null
    topicEnvelope?: string | null
    now: number
  }): RoomRecord {
    if (this.room && this.room.deletedAt === null) {
      // Idempotent create: a room with this id already exists. Keep it.
      return this.room
    }
    const lifetime = clampRoomLifetime(input.roomLifetimeMs)
    this.room = {
      roomId: input.roomId,
      accessProofHash: input.accessProofHash,
      inviteExpiresAt: input.inviteExpiresAt,
      defaultTtlMs: clampTtl(input.ttlMs, DEFAULT_MESSAGE_TTL_MS),
      burnAfterRead: input.burnAfterRead ?? false,
      createdAt: input.now,
      deletedAt: null,
      destroyAt: lifetime > 0 ? input.now + lifetime : null,
      ownerKeyHash: input.ownerKeyHash ?? null,
      topicEnvelope: input.topicEnvelope ?? null,
      banned: [],
      ipBanned: [],
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

  /** Verify a hashed owner proof. False when no owner is registered. */
  verifyOwner(ownerKeyHash: string): boolean {
    if (!this.room || this.room.deletedAt !== null) return false
    if (!this.room.ownerKeyHash) return false
    return timingSafeEqual(this.room.ownerKeyHash, ownerKeyHash)
  }

  isInviteExpired(now: number): boolean {
    return !!this.room?.inviteExpiresAt && this.room.inviteExpiresAt <= now
  }

  /** True once a room with a lifetime has passed its self-destruct time. */
  isRoomDestroyed(now: number): boolean {
    return (
      !!this.room &&
      this.room.deletedAt === null &&
      this.room.destroyAt !== null &&
      this.room.destroyAt <= now
    )
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
    destroyAt?: number | null
  }): RoomRecord | null {
    if (!this.room || this.room.deletedAt !== null) return null
    if (input.inviteExpiresAt !== undefined) this.room.inviteExpiresAt = input.inviteExpiresAt
    if (input.ttlMs !== undefined) this.room.defaultTtlMs = clampTtl(input.ttlMs, this.room.defaultTtlMs)
    if (input.burnAfterRead !== undefined) this.room.burnAfterRead = input.burnAfterRead
    if (input.destroyAt !== undefined) this.room.destroyAt = input.destroyAt
    return this.room
  }

  /** Owner-only: set or clear the opaque encrypted room topic. */
  setTopic(topicEnvelope: string | null): RoomRecord | null {
    if (!this.room || this.room.deletedAt !== null) return null
    this.room.topicEnvelope = topicEnvelope
    return this.room
  }

  // ---------- bans ----------

  banParticipant(participantId: string): void {
    if (!this.room || this.room.deletedAt !== null) return
    if (!participantId) return
    if (!this.room.banned.includes(participantId)) this.room.banned.push(participantId)
    // A banned participant is no longer an active member.
    this.participants.delete(participantId)
  }

  unbanParticipant(participantId: string): void {
    if (!this.room || this.room.deletedAt !== null) return
    this.room.banned = this.room.banned.filter((id) => id !== participantId)
  }

  isBanned(participantId: string): boolean {
    return !!this.room && this.room.banned.includes(participantId)
  }

  // ---------- IP bans ----------

  banIp(ip: string): void {
    if (!this.room || this.room.deletedAt !== null || !ip) return
    if (!this.room.ipBanned.includes(ip)) this.room.ipBanned.push(ip)
  }

  unbanIp(ip: string): void {
    if (!this.room || this.room.deletedAt !== null) return
    this.room.ipBanned = this.room.ipBanned.filter((b) => b !== ip)
  }

  isIpBanned(ip: string | null | undefined): boolean {
    if (!ip || !this.room || this.room.deletedAt !== null) return false
    return this.room.ipBanned.includes(ip)
  }

  getIpBannedList(): string[] {
    return [...(this.room?.ipBanned ?? [])]
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
    const prev = this.participants.get(participantId)
    this.participants.set(participantId, { ...prev, lastSeen: now })
  }

  /**
   * Bind a participant id to a device-local proof hash. Existing legacy
   * participants without a proof are upgraded on first successful session.
   */
  registerParticipant(participantId: string, now: number, proofHash: string): boolean {
    if (!participantId || !proofHash) return false
    const prev = this.participants.get(participantId)
    if (prev?.proofHash && !timingSafeEqual(prev.proofHash, proofHash)) return false
    this.participants.set(participantId, { ...prev, lastSeen: now, proofHash })
    return true
  }

  verifyParticipant(participantId: string, proofHash: string | undefined): boolean {
    if (!participantId || !proofHash) return false
    const prev = this.participants.get(participantId)
    if (!prev?.proofHash) return false
    return timingSafeEqual(prev.proofHash, proofHash)
  }

  participantLastSeen(participantId: string): number | null {
    return this.participants.get(participantId)?.lastSeen ?? null
  }

  participantCount(now: number, windowMs = 45 * 1000): number {
    let count = 0
    for (const { lastSeen } of this.participants.values()) {
      if (now - lastSeen <= windowMs) count++
    }
    return count
  }

  recordParticipantIp(participantId: string, ip: string): void {
    const prev = this.participants.get(participantId)
    if (!prev) return
    this.participants.set(participantId, { ...prev, ip })
  }

  getParticipantIps(): Array<{ participantId: string; ip: string | null; lastSeen: number }> {
    return Array.from(this.participants.entries()).map(([participantId, rec]) => ({
      participantId,
      ip: rec.ip ?? null,
      lastSeen: rec.lastSeen,
    }))
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

  /**
   * Replace the encrypted envelope of a message the caller authored. Used for
   * "edit your own message". The server never sees the plaintext; it only swaps
   * one opaque envelope for another and stamps editedAt. Returns null when the
   * message is missing, not owned by the caller, or already deleted.
   */
  editMessage(
    input: { messageId: string; participantId: string; envelope: string },
    now: number,
  ): StoredMessage | null {
    const m = this.messages.get(input.messageId)
    if (!m) return null
    if (m.participantId !== input.participantId) return null
    if (m.deletedAt) return null
    m.envelope = input.envelope
    m.editedAt = now
    return m
  }

  /**
   * Soft-delete a message the caller authored, leaving a tombstone so peers see
   * "message deleted" instead of stale ciphertext. Frees any backing R2 bytes.
   * Returns null when missing or not owned by the caller.
   */
  deleteOwnMessage(
    input: { messageId: string; participantId: string },
    now: number,
  ): { message: StoredMessage; orphanObjectKeys: string[] } | null {
    const m = this.messages.get(input.messageId)
    if (!m) return null
    if (m.participantId !== input.participantId) return null
    const orphanObjectKeys = (m.media ?? []).map((ref) => ref.objectKey)
    const tomb: StoredMessage = {
      ...m,
      envelope: "",
      media: undefined,
      reactions: undefined,
      burn: false,
      deletedAt: now,
    }
    this.messages.set(m.id, tomb)
    return { message: tomb, orphanObjectKeys }
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
    if (m.deletedAt) return null
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

  pruneOwn(
    messageIds: string[],
    participantId: string,
  ): { removedIds: string[]; orphanObjectKeys: string[] } {
    const ownIds = messageIds.filter((id) => this.messages.get(id)?.participantId === participantId)
    return this.prune(ownIds)
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

  /** Next timestamp the room should wake up to act, or null if nothing pending. */
  nextExpiry(): number | null {
    let next: number | null = null
    for (const m of this.messages.values()) {
      if (m.expiresAt !== null && (next === null || m.expiresAt < next)) next = m.expiresAt
    }
    if (this.room && this.room.deletedAt === null && this.room.destroyAt !== null) {
      if (next === null || this.room.destroyAt < next) next = this.room.destroyAt
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
      destroyAt: this.room.destroyAt,
      topicEnvelope: this.room.topicEnvelope ?? null,
      hasOwner: !!this.room.ownerKeyHash,
      banned: [...this.room.banned],
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
