// The encrypted messages this device holds for a room, exactly as the server
// sent them, plus the bookkeeping that keeps them right when answers arrive out
// of order. A sync answer the server put together a moment ago can land after a
// live frame, or after the reply to one of our own requests, that is newer than
// it; neither an old copy nor an old id list may undo the newer state.
import type { StoredMessage } from "@shared/types"

/** Server time of a message's latest change (its creation if it never changed). */
export function messageVersion(m: StoredMessage): number {
  return m.updatedAt ?? m.createdAt
}

/** Whether two copies of a message carry the same server state. */
export function sameStored(a: StoredMessage, b: StoredMessage): boolean {
  if (a === b) return true
  if (
    a.envelope !== b.envelope ||
    a.expiresAt !== b.expiresAt ||
    (a.updatedAt ?? 0) !== (b.updatedAt ?? 0) ||
    (a.editedAt ?? null) !== (b.editedAt ?? null) ||
    (a.deletedAt ?? null) !== (b.deletedAt ?? null) ||
    !!a.burn !== !!b.burn ||
    (a.media?.length ?? 0) !== (b.media?.length ?? 0)
  ) {
    return false
  }
  const ra = a.reactions ?? {}
  const rb = b.reactions ?? {}
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  for (const key of keys) {
    const x = ra[key]
    const y = rb[key]
    if (!y || x.envelope !== y.envelope || x.participantId !== y.participantId) return false
  }
  return true
}

// How long a removed message's id is remembered, so an answer the server put
// together before the removal can't bring the message back.
const REMOVED_TTL_MS = 120_000
const MAX_REMOVED = 2_000

export type AcceptResult = "added" | "updated" | null

export class MessageStore {
  private byId = new Map<string, StoredMessage>()
  // Ids with a change made on this device that no server copy has confirmed
  // yet: a reaction or "kept" frame, or our own edit before the reply.
  private local = new Set<string>()
  // Recently removed id -> when it was removed (device time).
  private removed = new Map<string, number>()

  get size(): number {
    return this.byId.size
  }

  get(id: string): StoredMessage | undefined {
    return this.byId.get(id)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  values(): IterableIterator<StoredMessage> {
    return this.byId.values()
  }

  /**
   * Take a copy of a message from the server: from a sync, a live frame or the
   * reply to our own request. Ignored when it is older than the copy held here
   * or the message was removed a moment ago.
   */
  accept(m: StoredMessage, now = Date.now()): AcceptResult {
    if (this.wasRemoved(m.id, now)) return null
    const held = this.byId.get(m.id)
    if (!held) {
      this.byId.set(m.id, m)
      this.local.delete(m.id)
      return "added"
    }
    const incoming = messageVersion(m)
    const current = messageVersion(held)
    if (incoming < current) return null
    // Same version: our local change is newer, or nothing changed.
    if (incoming === current && (this.local.has(m.id) || sameStored(held, m))) return null
    this.byId.set(m.id, m)
    this.local.delete(m.id)
    return "updated"
  }

  /**
   * Apply a change on this device ahead of the server's copy of it (reaction
   * and "kept" frames carry no server time; optimistic edits and deletes).
   */
  patch(next: StoredMessage): void {
    this.byId.set(next.id, next)
    this.local.add(next.id)
  }

  /** Put back a server copy, e.g. when an optimistic change failed. */
  restore(prev: StoredMessage): void {
    this.byId.set(prev.id, prev)
    this.local.delete(prev.id)
  }

  /** Drop a message the server removed (or never kept), and remember that. */
  remove(id: string, now = Date.now()): boolean {
    const had = this.byId.delete(id)
    this.local.delete(id)
    this.removed.delete(id)
    this.removed.set(id, now)
    if (this.removed.size > MAX_REMOVED) this.trimRemoved(now)
    return had
  }

  /** Remove everything held (the whole room was cleared). */
  removeAll(now = Date.now()): string[] {
    const ids = [...this.byId.keys()]
    for (const id of ids) this.remove(id, now)
    return ids
  }

  /** Forget everything, including what was removed (leaving the room). */
  clear(): void {
    this.byId.clear()
    this.local.clear()
    this.removed.clear()
  }

  wasRemoved(id: string, now = Date.now()): boolean {
    const at = this.removed.get(id)
    if (at === undefined) return false
    if (now - at <= REMOVED_TTL_MS) return true
    this.removed.delete(id)
    return false
  }

  /**
   * Compare against the server's full id list (oldest first) as of
   * `serverTime`. Drops messages the server no longer has, and reports where to
   * fetch from again when it holds one this device doesn't.
   */
  reconcile(
    currentIds: readonly string[],
    serverTime: number,
    now = Date.now(),
  ): { removedIds: string[]; missingFrom: number | null } {
    const current = new Set(currentIds)
    const removedIds: string[] = []
    for (const [id, m] of this.byId) {
      // A message newer than the list arrived after it was put together, so
      // its absence from the list means nothing.
      if (!current.has(id) && m.createdAt < serverTime) removedIds.push(id)
    }
    for (const id of removedIds) this.remove(id, now)
    let previous: StoredMessage | undefined
    for (const id of currentIds) {
      const held = this.byId.get(id)
      if (held) {
        previous = held
        continue
      }
      if (this.wasRemoved(id, now)) continue
      // The list is oldest first, so the missing message is no older than the
      // last one held before it: fetching from just before that one gets it.
      return { removedIds, missingFrom: previous ? Math.max(0, previous.createdAt - 1) : 0 }
    }
    return { removedIds, missingFrom: null }
  }

  private trimRemoved(now: number): void {
    for (const [id, at] of this.removed) {
      if (this.removed.size <= MAX_REMOVED && now - at <= REMOVED_TTL_MS) break
      this.removed.delete(id)
    }
  }
}
