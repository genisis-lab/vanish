// Durable Object persistence for a room, one storage value per message.
//
// Rooms used to be saved as a single "snapshot" value holding every message.
// Cloudflare caps one key+value at 2 MB on SQLite-backed Durable Objects, and a
// room's history passes that well before the 2000-message cap (a dozen
// max-size envelopes already do), especially in rooms whose timer is "Never".
// Once over the cap every save failed. Now the room record and participants
// live under META_KEY and each message under its own `msg:<id>` key.
//
// The store diffs against what it last wrote, so a save rewrites only messages
// that changed. It compares content rather than tracking mutations, because
// RoomCore edits messages in place (reactions, edits, tombstones) and a missed
// dirty flag would silently lose data. To keep that cheap the (large) envelope
// is compared as a string, which is a pointer check when unchanged, and only
// the small remaining fields are serialized. The cache is only updated after a
// write succeeds, so a failed save is retried by the next one.

import type { RoomRecord, RoomSnapshot, ParticipantRecord } from "../../shared/roomCore"
import type { StoredMessage } from "../../shared/types"

export const LEGACY_SNAPSHOT_KEY = "snapshot"
export const META_KEY = "room:meta"
export const MESSAGE_KEY_PREFIX = "msg:"
/** Cloudflare's per-call limit on keys for put(entries) and delete(keys). */
const MAX_KEYS_PER_CALL = 128

interface RoomMeta {
  v: 2
  room: RoomRecord | null
  participants: RoomSnapshot["participants"]
}

/** The slice of DurableObjectStorage this module needs (easy to fake in tests). */
export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>
  put(entries: Record<string, unknown>): Promise<void>
  delete(keys: string[]): Promise<number>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

function messageKey(id: string): string {
  return MESSAGE_KEY_PREFIX + id
}

function chunks<T>(items: T[], size = MAX_KEYS_PER_CALL): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** What was last written for one message: its envelope and everything else. */
interface RowPrint {
  envelope: string
  rest: string
}

function printOf(message: StoredMessage): RowPrint {
  const { envelope, ...rest } = message
  return { envelope, rest: JSON.stringify(rest) }
}

export class RoomStore {
  private storage: KvStorage
  /** Last successfully written message rows, keyed by storage key. */
  private rows = new Map<string, RowPrint>()
  /** Serialized meta as last written. */
  private meta: string | null = null

  constructor(storage: KvStorage) {
    this.storage = storage
  }

  /**
   * Load the room. Rooms saved in the legacy single-snapshot format are read
   * from it and rewritten in the per-message format, after which the snapshot
   * is deleted. Returns undefined for a room that has never been saved.
   */
  async load(): Promise<RoomSnapshot | undefined> {
    const meta = await this.storage.get<RoomMeta>(META_KEY)
    if (meta) {
      const rows = await this.storage.list<StoredMessage>({ prefix: MESSAGE_KEY_PREFIX })
      const snapshot: RoomSnapshot = {
        room: meta.room,
        participants: meta.participants ?? {},
        messages: [...rows.values()],
      }
      this.meta = JSON.stringify(this.metaOf(snapshot))
      for (const [key, message] of rows) this.rows.set(key, printOf(message))
      // A migration that crashed after writing the new format but before
      // deleting the old snapshot leaves it behind; drop it now.
      const legacy = await this.storage.get<RoomSnapshot>(LEGACY_SNAPSHOT_KEY)
      if (legacy) await this.storage.delete([LEGACY_SNAPSHOT_KEY])
      return snapshot
    }
    const legacy = await this.storage.get<RoomSnapshot>(LEGACY_SNAPSHOT_KEY)
    if (!legacy) return undefined
    const snapshot: RoomSnapshot = {
      room: legacy.room ?? null,
      participants: legacy.participants ?? {},
      messages: legacy.messages ?? [],
    }
    // Message rows are written before the meta key, so a crash part-way leaves
    // no meta and the next load migrates again from the untouched snapshot.
    await this.save(snapshot, { deleteLegacy: true })
    return snapshot
  }

  /** Write whatever changed since the last successful save. */
  async save(snapshot: RoomSnapshot, opts: { deleteLegacy?: boolean } = {}): Promise<void> {
    const upserts: Array<[string, StoredMessage, RowPrint]> = []
    const live = new Set<string>()
    for (const message of snapshot.messages) {
      const key = messageKey(message.id)
      live.add(key)
      const print = printOf(message)
      const prev = this.rows.get(key)
      if (!prev || prev.envelope !== print.envelope || prev.rest !== print.rest) {
        upserts.push([key, message, print])
      }
    }
    const removed = [...this.rows.keys()].filter((key) => !live.has(key))
    const meta = this.metaOf(snapshot)
    const metaSerialized = JSON.stringify(meta)
    const metaChanged = this.meta !== metaSerialized
    if (!upserts.length && !removed.length && !metaChanged && !opts.deleteLegacy) return

    // Message rows first, then meta. Durable Objects usually coalesce writes
    // issued together into one atomic batch, but the migration in load() must
    // not depend on that: meta (the "new format is complete" marker) and the
    // legacy delete only happen once every message row is stored.
    const rowWrites: Promise<unknown>[] = []
    for (const batch of chunks(upserts)) {
      rowWrites.push(this.storage.put(Object.fromEntries(batch.map(([key, value]) => [key, value]))))
    }
    for (const batch of chunks(removed)) rowWrites.push(this.storage.delete(batch))
    await Promise.all(rowWrites)
    const metaWrites: Promise<unknown>[] = []
    if (metaChanged || opts.deleteLegacy) metaWrites.push(this.storage.put({ [META_KEY]: meta }))
    if (opts.deleteLegacy) metaWrites.push(this.storage.delete([LEGACY_SNAPSHOT_KEY]))
    await Promise.all(metaWrites)

    for (const [key, , print] of upserts) this.rows.set(key, print)
    for (const key of removed) this.rows.delete(key)
    this.meta = metaSerialized
  }

  private metaOf(snapshot: RoomSnapshot): RoomMeta {
    return {
      v: 2,
      room: snapshot.room,
      participants: snapshot.participants as Record<string, ParticipantRecord | number>,
    }
  }
}
