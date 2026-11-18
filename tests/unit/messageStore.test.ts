import { describe, expect, it } from "vitest"
import type { StoredMessage } from "@shared/types"
import { MessageStore, sameStored } from "../../src/lib/messageStore"

const msg = (id: string, createdAt: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  id,
  roomId: "room",
  participantId: "p",
  envelope: "env-" + id,
  kind: "text",
  createdAt,
  expiresAt: createdAt + 60_000,
  ...extra,
})

describe("MessageStore.accept", () => {
  it("adds new messages and ignores identical repeats", () => {
    const store = new MessageStore()
    expect(store.accept(msg("a", 100))).toBe("added")
    expect(store.accept(msg("a", 100))).toBeNull()
    expect(store.size).toBe(1)
  })

  it("applies newer copies and ignores older ones", () => {
    const store = new MessageStore()
    store.accept(msg("a", 100))
    const edited = msg("a", 100, { envelope: "edited", editedAt: 200, updatedAt: 200 })
    expect(store.accept(edited)).toBe("updated")
    // A sync answer put together before the edit arrives late.
    expect(store.accept(msg("a", 100))).toBeNull()
    expect(store.get("a")?.envelope).toBe("edited")
  })

  it("keeps a change made here until a newer server copy confirms it", () => {
    const store = new MessageStore()
    const original = msg("a", 100)
    store.accept(original)
    const reactions = { r1: { participantId: "q", envelope: "heart" } }
    store.patch({ ...original, reactions })
    // Same server version without the reaction: older news than the patch.
    expect(store.accept(msg("a", 100))).toBeNull()
    expect(store.get("a")?.reactions).toEqual(reactions)
    expect(store.accept(msg("a", 100, { reactions, updatedAt: 150 }))).toBe("updated")
    // Confirmed, so the same version with different content is the server's truth again.
    expect(store.accept(msg("a", 100, { updatedAt: 150 }))).toBe("updated")
  })

  it("does not bring back a message that was just removed", () => {
    const store = new MessageStore()
    store.accept(msg("a", 100))
    store.remove("a", 1_000)
    expect(store.accept(msg("a", 100), 2_000)).toBeNull()
    expect(store.has("a")).toBe(false)
    // Long after, the id is forgotten (ids are random and never reused).
    expect(store.accept(msg("a", 100), 1_000 + 121_000)).toBe("added")
  })

  it("restores a server copy over a failed optimistic change", () => {
    const store = new MessageStore()
    const original = msg("a", 100)
    store.accept(original)
    store.patch({ ...original, envelope: "", deletedAt: 300 })
    store.restore(original)
    expect(store.get("a")).toBe(original)
    expect(store.accept(msg("a", 100, { envelope: "x", updatedAt: 100 }))).toBe("updated")
  })
})

describe("MessageStore.reconcile", () => {
  it("drops messages the server no longer has, but not ones newer than its list", () => {
    const store = new MessageStore()
    store.accept(msg("old", 100))
    store.accept(msg("kept", 200))
    // Arrived (live, or as the reply to our own send) after the list was made.
    store.accept(msg("fresh", 600))
    const { removedIds, missingFrom } = store.reconcile(["kept"], 500)
    expect(removedIds).toEqual(["old"])
    expect(missingFrom).toBeNull()
    expect(store.has("fresh")).toBe(true)
  })

  it("asks to fetch again from just before the first message it is missing", () => {
    const store = new MessageStore()
    store.accept(msg("a", 100))
    store.accept(msg("b", 300))
    store.accept(msg("d", 700))
    expect(store.reconcile(["a", "b", "c", "d"], 900).missingFrom).toBe(299)
    const empty = new MessageStore()
    expect(empty.reconcile(["a"], 900).missingFrom).toBe(0)
  })

  it("ignores ids it removed a moment ago", () => {
    const store = new MessageStore()
    store.accept(msg("a", 100))
    store.remove("a")
    expect(store.reconcile(["a"], 900)).toEqual({ removedIds: [], missingFrom: null })
  })
})

describe("sameStored", () => {
  it("compares envelopes, timers, edits and reactions", () => {
    const base = msg("a", 100, { reactions: { r: { participantId: "q", envelope: "e" } } })
    expect(sameStored(base, { ...base, reactions: { r: { participantId: "q", envelope: "e" } } })).toBe(true)
    expect(sameStored(base, { ...base, expiresAt: null })).toBe(false)
    expect(sameStored(base, { ...base, reactions: {} })).toBe(false)
    expect(sameStored(base, { ...base, envelope: "other" })).toBe(false)
  })
})
