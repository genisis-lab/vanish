import { describe, expect, it } from "vitest"
import { RoomCore } from "@shared/roomCore"
import { deriveKeys, hashAccessProof } from "@shared/crypto"
import { createInvite } from "@shared/invite"
import { inviteExpiryToMs } from "@shared/constants"

async function freshRoom(opts?: { inviteExpiry?: "never" | "24h" | "7d"; ttlMs?: number; burn?: boolean }) {
  const invite = createInvite()
  const keys = await deriveKeys(invite.secret, invite.roomId)
  const now = Date.now()
  const core = new RoomCore()
  core.createRoom({
    roomId: invite.roomId,
    accessProofHash: keys.accessProofHash,
    inviteExpiresAt: inviteExpiryToMs(opts?.inviteExpiry ?? "never", now),
    ttlMs: opts?.ttlMs,
    burnAfterRead: opts?.burn,
    now,
  })
  return { invite, keys, core, now }
}

describe("RoomCore invite validation", () => {
  it("denies an unknown room", async () => {
    const core = new RoomCore()
    expect(core.validateInvite("whatever", Date.now())).toBe("invalid")
  })

  it("denies a wrong access proof", async () => {
    const { core } = await freshRoom()
    const other = createInvite()
    const otherKeys = await deriveKeys(other.secret, other.roomId)
    expect(core.validateInvite(otherKeys.accessProofHash, Date.now())).toBe("invalid")
  })

  it("accepts a valid key holder", async () => {
    const { core, keys } = await freshRoom()
    expect(core.validateInvite(keys.accessProofHash, Date.now())).toBe("valid")
  })

  it("blocks an expired invite but keeps the room", async () => {
    const { core, keys, now } = await freshRoom({ inviteExpiry: "24h" })
    const later = now + 25 * 60 * 60 * 1000
    expect(core.validateInvite(keys.accessProofHash, later)).toBe("expired")
    expect(core.exists()).toBe(true)
  })
})

describe("RoomCore rejoin + multi-party", () => {
  it("key holder can rejoin and post after the room exists", async () => {
    const { core, keys, now } = await freshRoom()
    expect(core.verifyHash(keys.accessProofHash)).toBe(true)
    const msg = core.addMessage(
      { id: "m1", participantId: "p1", envelope: "enc", kind: "text" },
      now,
    )
    expect(msg.roomId).toBe(core.getRoom()?.roomId)
  })

  it("supports more than two participants (no 2-user cap)", async () => {
    const { core, now } = await freshRoom()
    core.touchParticipant("p1", now)
    core.touchParticipant("p2", now)
    core.touchParticipant("p3", now)
    core.touchParticipant("p4", now)
    expect(core.participantCount(now)).toBe(4)
  })
})

describe("RoomCore participant proof binding", () => {
  it("pins a participant id to the first registered participant proof hash", async () => {
    const { core, now } = await freshRoom()
    expect(core.registerParticipant("p1", now, "proof-a")).toBe(true)
    expect(core.verifyParticipant("p1", "proof-a")).toBe(true)
    expect(core.verifyParticipant("p1", "proof-b")).toBe(false)
    expect(core.registerParticipant("p1", now + 1000, "proof-b")).toBe(false)
    expect(core.participantCount(now + 1000)).toBe(1)
  })

  it("upgrades a legacy participant heartbeat to a proof-bound participant", async () => {
    const { core, now } = await freshRoom()
    core.touchParticipant("legacy", now)
    expect(core.registerParticipant("legacy", now + 1000, "legacy-proof")).toBe(true)
    expect(core.verifyParticipant("legacy", "legacy-proof")).toBe(true)
    expect(core.verifyParticipant("legacy", "other-proof")).toBe(false)
  })
})

describe("RoomCore pruning + expiry + delete", () => {
  it("auto-expires messages by ttl", async () => {
    const { core, now } = await freshRoom({ ttlMs: 60_000 })
    core.addMessage({ id: "m1", participantId: "p1", envelope: "e", kind: "text" }, now)
    expect(core.list(now).length).toBe(1)
    const swept = core.sweep(now + 61_000)
    expect(swept.removedIds).toContain("m1")
    expect(core.list(now + 61_000).length).toBe(0)
  })

  it("burn-after-read removes on read by another participant", async () => {
    const { core, now } = await freshRoom({ burn: true })
    core.addMessage({ id: "m1", participantId: "author", envelope: "e", kind: "text" }, now)
    // author reading does not burn
    expect(core.markRead("author", now).burnedIds).toHaveLength(0)
    // a different reader burns it
    expect(core.markRead("reader", now).burnedIds).toContain("m1")
    expect(core.list(now).length).toBe(0)
  })

  it("prunes selected messages and reports orphan media keys", async () => {
    const { core, now } = await freshRoom()
    core.addMessage(
      {
        id: "m1",
        participantId: "p1",
        envelope: "e",
        kind: "media",
        media: [{ objectKey: "rooms/r/o1", size: 10, previewKind: "image" }],
      },
      now,
    )
    core.addMessage({ id: "m2", participantId: "p1", envelope: "e", kind: "text" }, now)
    const res = core.prune(["m1"])
    expect(res.removedIds).toEqual(["m1"])
    expect(res.orphanObjectKeys).toContain("rooms/r/o1")
    expect(core.list(now).map((m) => m.id)).toEqual(["m2"])
  })

  it("only prunes messages owned by the requesting participant", async () => {
    const { core, now } = await freshRoom()
    core.addMessage({ id: "mine", participantId: "p1", envelope: "e", kind: "text" }, now)
    core.addMessage({ id: "theirs", participantId: "p2", envelope: "e", kind: "text" }, now)
    const res = core.pruneOwn(["mine", "theirs"], "p1")
    expect(res.removedIds).toEqual(["mine"])
    expect(core.list(now).map((m) => m.id)).toEqual(["theirs"])
  })

  it("delete room clears messages and returns all media keys", async () => {
    const { core, now } = await freshRoom()
    core.addMessage(
      {
        id: "m1",
        participantId: "p1",
        envelope: "e",
        kind: "media",
        media: [{ objectKey: "rooms/r/o1", size: 10, previewKind: "video" }],
      },
      now,
    )
    const keys = core.deleteRoom(now)
    expect(keys).toContain("rooms/r/o1")
    expect(core.exists()).toBe(false)
    expect(core.validateInvite("x", now)).toBe("deleted")
  })
})

describe("RoomCore proof requirement (server-side gate simulation)", () => {
  it("prune/delete require a proof that hashes to the verifier", async () => {
    const { core, invite, keys, now } = await freshRoom()
    // Simulate the edge gate: only proceed if hashed proof matches verifier.
    const goodProofHash = await hashAccessProof(keys.accessProof)
    expect(core.verifyHash(goodProofHash)).toBe(true)

    const attacker = await deriveKeys(createInvite().secret, invite.roomId)
    const badHash = await hashAccessProof(attacker.accessProof)
    expect(core.verifyHash(badHash)).toBe(false)
    void now
  })
})
