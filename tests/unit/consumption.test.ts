import { describe, expect, it } from "vitest"
import { RoomCore } from "@shared/roomCore"

function room() {
  const core = new RoomCore()
  core.createRoom({
    roomId: "test-room",
    accessProofHash: "hash",
    inviteExpiresAt: null,
    ttlMs: 30_000,
    now: 1000,
  })
  return core
}

describe("read-once lifecycle", () => {
  it("listing preserves attachments until an explicit receipt, which consumes only named messages", () => {
    const core = room()
    core.addMessage(
      {
        id: "photo",
        participantId: "alice",
        kind: "media",
        envelope: "cipher",
        burn: true,
        media: [{ objectKey: "rooms/test/photo", size: 64 }],
      },
      1000,
    )
    core.addMessage(
      { id: "unopened", participantId: "alice", kind: "text", envelope: "cipher", burn: true },
      1000,
    )
    expect(core.list(2000)).toHaveLength(2)
    expect(core.hasObjectKey("rooms/test/photo")).toBe(true)
    expect(core.markRead("alice", 2000, ["photo"]).burnedIds).toEqual([])
    expect(core.markRead("bob", 2000, ["photo"])).toEqual({
      burnedIds: ["photo"],
      orphanObjectKeys: ["rooms/test/photo"],
    })
    expect(core.list(2000).map((m) => m.id)).toEqual(["unopened"])
    expect(core.markRead("bob", 2000, ["photo"]).burnedIds).toEqual([])
  })
  it("unopened read-once messages and media expire on their selected timer", () => {
    const core = room()
    const message = core.addMessage(
      {
        id: "photo",
        participantId: "alice",
        kind: "media",
        envelope: "cipher",
        burn: true,
        ttlMs: 10_000,
        media: [{ objectKey: "rooms/test/photo", size: 64 }],
      },
      1000,
    )
    expect(message.expiresAt).toBe(11_000)
    expect(core.sweep(11_000)).toEqual({
      removedIds: ["photo"],
      orphanObjectKeys: ["rooms/test/photo"],
    })
  })
  it("backfills expiry for legacy read-once envelopes when restoring a room", () => {
    const core = room()
    const m = core.addMessage(
      { id: "old", participantId: "alice", kind: "text", envelope: "cipher", burn: true },
      1000,
    )
    const restored = new RoomCore({ room: core.getRoom(), messages: [{ ...m, expiresAt: null }] })
    expect(restored.sweep(31_000).removedIds).toEqual(["old"])
  })
})
