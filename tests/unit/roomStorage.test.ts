import { describe, expect, it } from "vitest"
import { RoomCore } from "@shared/roomCore"
import {
  LEGACY_SNAPSHOT_KEY,
  META_KEY,
  MESSAGE_KEY_PREFIX,
  RoomStore,
  type KvStorage,
} from "../../room-worker/src/roomStorage"

// In-memory stand-in for Durable Object storage that enforces Cloudflare's
// limits: 2 MB per key+value on SQLite-backed objects, 128 keys per call, and
// values copied at write time (later in-place edits must not leak in).
class FakeStorage implements KvStorage {
  data = new Map<string, unknown>()
  puts = 0
  failNext = false

  private check(key: string, value: unknown) {
    const size = key.length + JSON.stringify(value).length
    if (size > 2 * 1024 * 1024) throw new Error(`value too large: ${key} (${size} bytes)`)
  }
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key)
    return v === undefined ? undefined : (structuredClone(v) as T)
  }
  async put(entries: Record<string, unknown>): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error("storage unavailable")
    }
    const keys = Object.keys(entries)
    if (keys.length > 128) throw new Error("too many keys")
    for (const k of keys) this.check(k, entries[k])
    for (const k of keys) this.data.set(k, structuredClone(entries[k]))
    this.puts += keys.length
  }
  async delete(keys: string[]): Promise<number> {
    if (keys.length > 128) throw new Error("too many keys")
    let n = 0
    for (const k of keys) if (this.data.delete(k)) n++
    return n
  }
  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>()
    for (const [k, v] of [...this.data].sort(([a], [b]) => a.localeCompare(b))) {
      if (k.startsWith(prefix)) out.set(k, structuredClone(v) as T)
    }
    return out
  }
  messageKeys() {
    return [...this.data.keys()].filter((k) => k.startsWith(MESSAGE_KEY_PREFIX))
  }
}

const ROOM_ID = "r".repeat(22)

function roomWith(count: number, envelopeChars = 700): RoomCore {
  const core = new RoomCore()
  core.createRoom({ roomId: ROOM_ID, accessProofHash: "h", inviteExpiresAt: null, ttlMs: 0, now: 1 })
  for (let i = 0; i < count; i++) {
    core.addMessage(
      { id: `m${String(i).padStart(5, "0")}`, participantId: "p", envelope: "A".repeat(envelopeChars), kind: "text" },
      10 + i,
    )
  }
  return core
}

describe("RoomStore", () => {
  it("saves rooms far past the old 2 MB single-value limit", async () => {
    const storage = new FakeStorage()
    const store = new RoomStore(storage)
    // 12 max-size envelopes: ~2.3 MB, which the old single snapshot could not hold.
    const big = roomWith(12, 200_000)
    await store.save(big.toSnapshot())
    // 2000 messages with 1 KB-bucket envelopes: ~3 MB, also over the old limit.
    const many = roomWith(2000, 1400)
    const manyStorage = new FakeStorage()
    await new RoomStore(manyStorage).save(many.toSnapshot())
    expect(manyStorage.messageKeys()).toHaveLength(2000)
    const reloaded = await new RoomStore(manyStorage).load()
    expect(reloaded?.messages).toHaveLength(2000)
  })

  it("rewrites only what changed", async () => {
    const storage = new FakeStorage()
    const store = new RoomStore(storage)
    const core = roomWith(50)
    await store.save(core.toSnapshot())
    storage.puts = 0
    core.addMessage({ id: "new", participantId: "p", envelope: "B", kind: "text" }, 999)
    await store.save(core.toSnapshot())
    // the new message plus the meta row (participant lastSeen moved)
    expect(storage.puts).toBe(2)
    storage.puts = 0
    await store.save(core.toSnapshot())
    expect(storage.puts).toBe(0)
  })

  it("persists in-place edits, reactions, tombstones and removals", async () => {
    const storage = new FakeStorage()
    const store = new RoomStore(storage)
    const core = roomWith(3)
    await store.save(core.toSnapshot())
    core.editMessage({ messageId: "m00000", participantId: "p", envelope: "edited" }, 50)
    core.setReaction({ messageId: "m00001", reactionId: "x", participantId: "p", envelope: "r" })
    core.deleteOwnMessage({ messageId: "m00002", participantId: "p" }, 60)
    await store.save(core.toSnapshot())
    let back = new RoomCore(await new RoomStore(storage).load())
    const byId = Object.fromEntries(back.list(70).map((m) => [m.id, m]))
    expect(byId.m00000.envelope).toBe("edited")
    expect(byId.m00001.reactions?.x?.envelope).toBe("r")
    expect(byId.m00002.deletedAt).toBe(60)

    core.prune(["m00000", "m00001"])
    await store.save(core.toSnapshot())
    expect(storage.messageKeys()).toEqual([MESSAGE_KEY_PREFIX + "m00002"])
    back = new RoomCore(await new RoomStore(storage).load())
    expect(back.list(70).map((m) => m.id)).toEqual(["m00002"])
  })

  it("migrates a legacy snapshot and deletes it", async () => {
    const storage = new FakeStorage()
    const core = roomWith(300)
    storage.data.set(LEGACY_SNAPSHOT_KEY, structuredClone(core.toSnapshot()))
    const loaded = await new RoomStore(storage).load()
    expect(loaded?.messages).toHaveLength(300)
    expect(storage.data.has(LEGACY_SNAPSHOT_KEY)).toBe(false)
    expect(storage.data.has(META_KEY)).toBe(true)
    expect(storage.messageKeys()).toHaveLength(300)
    const again = new RoomCore(await new RoomStore(storage).load())
    expect(again.getRoom()?.roomId).toBe(ROOM_ID)
    expect(again.list(1000)).toHaveLength(300)
  })

  it("re-migrates when a migration failed part-way, and cleans up a leftover snapshot", async () => {
    const storage = new FakeStorage()
    const core = roomWith(5)
    storage.data.set(LEGACY_SNAPSHOT_KEY, structuredClone(core.toSnapshot()))
    storage.failNext = true
    await expect(new RoomStore(storage).load()).rejects.toThrow()
    expect(storage.data.has(LEGACY_SNAPSHOT_KEY)).toBe(true)
    expect((await new RoomStore(storage).load())?.messages).toHaveLength(5)

    // New format already written but the old snapshot survived a crash.
    storage.data.set(LEGACY_SNAPSHOT_KEY, { room: null, messages: [], participants: {} })
    const loaded = await new RoomStore(storage).load()
    expect(loaded?.messages).toHaveLength(5)
    expect(storage.data.has(LEGACY_SNAPSHOT_KEY)).toBe(false)
  })

  it("retries a failed save on the next one", async () => {
    const storage = new FakeStorage()
    const store = new RoomStore(storage)
    const core = roomWith(1)
    await store.save(core.toSnapshot())
    core.addMessage({ id: "late", participantId: "p", envelope: "B", kind: "text" }, 999)
    storage.failNext = true
    await expect(store.save(core.toSnapshot())).rejects.toThrow()
    await store.save(core.toSnapshot())
    expect(storage.data.has(MESSAGE_KEY_PREFIX + "late")).toBe(true)
  })

  it("returns undefined for a room that was never saved", async () => {
    expect(await new RoomStore(new FakeStorage()).load()).toBeUndefined()
  })
})

describe("RoomDurableObject storage wiring", () => {
  it("wakes a legacy room, migrates it, and serves its messages", async () => {
    const { RoomDurableObject } = await import("../../room-worker/src/RoomDurableObject")
    const storage = Object.assign(new FakeStorage(), {
      getAlarm: async () => null,
      setAlarm: async () => {},
    })
    const core = roomWith(4)
    storage.data.set(LEGACY_SNAPSHOT_KEY, structuredClone(core.toSnapshot()))
    let ready: Promise<unknown> = Promise.resolve()
    const state = {
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
        ready = fn()
        return ready
      },
      getWebSockets: () => [],
      storage,
    }
    const room = new RoomDurableObject(state as unknown as DurableObjectState, {} as never)
    await ready
    expect(storage.data.has(LEGACY_SNAPSHOT_KEY)).toBe(false)
    expect(storage.messageKeys()).toHaveLength(4)
    const res = await room.fetch(new Request("https://room/validate", { method: "POST", body: "{}" }))
    expect(res.status).toBeLessThan(500)
  })
})

describe("room size caps", () => {
  it("drops the oldest messages past the stored-ciphertext budget", () => {
    const core = roomWith(10, 1000)
    // reactions count toward the budget too
    core.setReaction({ messageId: "m00009", reactionId: "x", participantId: "p", envelope: "R".repeat(500) })
    expect(core.overflowIds(2000, 10_500)).toEqual([])
    expect(core.overflowIds(2000, 8_000)).toEqual(["m00000", "m00001", "m00002"])
    expect(core.overflowIds(8, 1e9)).toEqual(["m00000", "m00001"])
  })

  it("keeps a room of max-size messages within the budget", async () => {
    const { MAX_ROOM_STORED_CHARS, MAX_ENVELOPE_CHARS } = await import("@shared/constants")
    const core = roomWith(200, MAX_ENVELOPE_CHARS)
    const drop = core.overflowIds(2000, MAX_ROOM_STORED_CHARS)
    expect(200 - drop.length).toBe(Math.floor(MAX_ROOM_STORED_CHARS / MAX_ENVELOPE_CHARS))
    expect(drop[0]).toBe("m00000")
  })
})
