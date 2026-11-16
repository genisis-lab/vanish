import { describe, expect, it, vi } from "vitest"
import { RoomDurableObject } from "../../room-worker/src/RoomDurableObject"
import { MAX_ROOM_STORED_CHARS, NEVER_EXPIRE_TTL_MS } from "../../shared/constants"
import { timerNoticeText } from "../../src/lib/messages"

// Builds a room object with one connected peer and proof checks stubbed out, so
// the test exercises the timer op itself rather than the crypto gates.
async function setup() {
  const peer = { deserializeAttachment: () => ({ participantId: "peer" }), send: vi.fn() }
  let ready: Promise<unknown> = Promise.resolve()
  const state = {
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ready = fn()
      return ready
    },
    getWebSockets: () => [peer],
    waitUntil: vi.fn(),
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      getAlarm: vi.fn().mockResolvedValue(null),
      setAlarm: vi.fn(),
    },
  }
  const room = new RoomDurableObject(state as unknown as DurableObjectState, {} as never)
  await ready
  const internals = room as unknown as Record<string, unknown> & {
    core: { createRoom(input: object): void; getRoom(): { defaultTtlMs: number } | null }
  }
  let ownerOk = true
  internals.verifyProof = async () => true
  internals.verifyParticipantProof = async () => true
  internals.verifyOwnerProof = async (proof?: string) => ownerOk && proof === "owner"
  internals.core.createRoom({
    roomId: "room-1",
    accessProofHash: "hash",
    inviteExpiresAt: null,
    ttlMs: 24 * 3_600_000,
    now: Date.now(),
  })
  const call = async (op: string, body: object) => {
    const res = await room.fetch(
      new Request(`https://room/${op}`, { method: "POST", body: JSON.stringify(body) }),
    )
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  const setTimer = (body: object) => call("set-timer", body)
  const frames = () => peer.send.mock.calls.map(([data]) => JSON.parse(data as string))
  const notOwner = () => {
    ownerOk = false
  }
  return { internals, setTimer, call, frames, state, notOwner, peer }
}

const base = {
  roomId: "room-1",
  accessProof: "proof",
  participantId: "changer",
  participantProof: "pproof",
}

describe("chat-wide disappearing timer", () => {
  it("updates the room for everyone and relays the notice without a push", async () => {
    const { internals, setTimer, frames, state } = await setup()
    const res = await setTimer({
      ...base,
      ttlMs: NEVER_EXPIRE_TTL_MS,
      notice: { id: "notice-1", envelope: "opaque" },
    })
    expect(res.status).toBe(200)
    expect(res.body.room.defaultTtlMs).toBe(NEVER_EXPIRE_TTL_MS)
    expect(internals.core.getRoom()?.defaultTtlMs).toBe(NEVER_EXPIRE_TTL_MS)
    expect(res.body.message).toMatchObject({ id: "notice-1", kind: "system", expiresAt: null })
    expect(frames().map((f) => f.t)).toEqual(["room-updated", "message"])
    expect(frames()[0].room.defaultTtlMs).toBe(NEVER_EXPIRE_TTL_MS)
    expect(state.waitUntil).not.toHaveBeenCalled()
  })

  it("posts nothing when the timer is unchanged", async () => {
    const { setTimer, frames } = await setup()
    const res = await setTimer({
      ...base,
      ttlMs: 24 * 3_600_000,
      notice: { id: "notice-1", envelope: "opaque" },
    })
    expect(res.status).toBe(200)
    expect(res.body.message).toBeUndefined()
    expect(frames()).toEqual([])
  })

  it("rejects banned members and bad input", async () => {
    const { internals, setTimer } = await setup()
    expect((await setTimer({ ...base, ttlMs: "never" })).status).toBe(400)
    expect(
      (await setTimer({ ...base, ttlMs: 60_000, notice: { id: "", envelope: "x" } })).status,
    ).toBe(400)
    ;(internals.core as unknown as { banParticipant(id: string): void }).banParticipant("changer")
    expect((await setTimer({ ...base, ttlMs: 60_000 })).status).toBe(403)
  })
})

describe("room storage budget on edits and reactions", () => {
  it("refuses an edit or reaction that would push the room over budget", async () => {
    const { internals, call } = await setup()
    const core = internals.core as unknown as {
      addMessage(input: object, now: number): unknown
      storedTotal(): number
    }
    core.addMessage({ id: "m1", participantId: "changer", envelope: "abc", kind: "text" }, Date.now())
    const total = core.storedTotal.bind(core)
    core.storedTotal = () => total() + MAX_ROOM_STORED_CHARS - 10

    // Shrinking or growing within the remaining budget is fine.
    expect((await call("edit", { ...base, messageId: "m1", envelope: "a" })).status).toBe(200)
    expect((await call("edit", { ...base, messageId: "m1", envelope: "a".repeat(8) })).status).toBe(200)
    // Growing past it is refused, and nothing changes.
    const tooBig = await call("edit", { ...base, messageId: "m1", envelope: "a".repeat(40) })
    expect(tooBig.status).toBe(413)
    expect(tooBig.body.error).toBe("room storage full")

    const reaction = { ...base, messageId: "m1", reactionId: "r1" }
    expect((await call("react", { ...reaction, envelope: "r".repeat(40) })).status).toBe(413)
    expect((await call("react", { ...reaction, envelope: "r" })).status).toBe(200)
    // Removing a reaction always works.
    expect((await call("react", { ...reaction, envelope: null })).status).toBe(200)
  })
})

describe("keeping existing messages when switching to Never", () => {
  const seed = (internals: Record<string, unknown>) => {
    const core = internals.core as {
      addMessage(input: object, now: number): { expiresAt: number | null }
    }
    const now = Date.now()
    core.addMessage({ id: "old", participantId: "p", envelope: "e", kind: "text" }, now)
    core.addMessage({ id: "burn", participantId: "p", envelope: "e", kind: "text", burn: true }, now)
    // cover traffic: never shown, so the client never lists it
    core.addMessage({ id: "decoy", participantId: "p", envelope: "e", kind: "text", ttlMs: 45_000 }, now)
  }
  const keepIds = ["old", "burn"]

  it("clears the countdown on existing messages and tells everyone", async () => {
    const { internals, setTimer, frames } = await setup()
    seed(internals)
    const res = await setTimer({
      ...base,
      ttlMs: NEVER_EXPIRE_TTL_MS,
      keepIds,
      notice: { id: "notice-1", envelope: "opaque" },
    })
    expect(res.status).toBe(200)
    expect(res.body.keptIds).toEqual(["old"])
    expect(frames().map((f) => f.t)).toEqual(["room-updated", "kept", "message"])
    expect(frames()[1].messageIds).toEqual(["old"])
  })

  it("can keep them later, once the chat is already on Never", async () => {
    const { internals, setTimer, frames } = await setup()
    seed(internals)
    await setTimer({ ...base, ttlMs: NEVER_EXPIRE_TTL_MS })
    const res = await setTimer({ ...base, ttlMs: NEVER_EXPIRE_TTL_MS, keepIds })
    expect(res.body.keptIds).toEqual(["old"])
    expect(frames().filter((f) => f.t === "kept")).toHaveLength(1)
  })

  it("ignores keepIds for timed values, validates them, and respects the owner lock", async () => {
    const { internals, call, setTimer, notOwner } = await setup()
    seed(internals)
    const timed = await setTimer({ ...base, ttlMs: 60_000, keepIds })
    expect(timed.body.keptIds).toEqual([])
    expect((await setTimer({ ...base, ttlMs: NEVER_EXPIRE_TTL_MS, keepIds: "old" })).status).toBe(400)
    expect((await setTimer({ ...base, ttlMs: NEVER_EXPIRE_TTL_MS, keepIds: [""] })).status).toBe(400)
    await call("update", { ...base, ownerProof: "owner", lockTimer: true })
    notOwner()
    const locked = await setTimer({ ...base, ttlMs: NEVER_EXPIRE_TTL_MS, keepIds })
    expect(locked.status).toBe(403)
  })
})

describe("owner timer lock", () => {
  it("blocks members but not the owner while locked, and broadcasts the lock", async () => {
    const { call, setTimer, frames } = await setup()
    const lock = await call("update", { ...base, ownerProof: "owner", lockTimer: true })
    expect(lock.status).toBe(200)
    expect(lock.body.room.timerLocked).toBe(true)
    expect(frames().at(-1)).toMatchObject({ t: "room-updated", room: { timerLocked: true } })
    expect((await setTimer({ ...base, ttlMs: 60_000 })).status).toBe(403)
    const owner = await setTimer({ ...base, ttlMs: 60_000, ownerProof: "owner" })
    expect(owner.status).toBe(200)
    expect(owner.body.room.defaultTtlMs).toBe(60_000)
  })

  it("only lets the owner lock it", async () => {
    const { call, notOwner } = await setup()
    notOwner()
    expect((await call("update", { ...base, ownerProof: "x", lockTimer: true })).status).toBe(403)
  })
})

describe("pinned message", () => {
  it("lets the owner pin and unpin, and tells everyone", async () => {
    const { call, frames } = await setup()
    const pin = await call("set-pin", { ...base, ownerProof: "owner", pinEnvelope: "opaque-pin" })
    expect(pin.status).toBe(200)
    expect(pin.body.room.pinEnvelope).toBe("opaque-pin")
    expect(frames().at(-1)).toMatchObject({ t: "room-updated", room: { pinEnvelope: "opaque-pin" } })
    const unpin = await call("set-pin", { ...base, ownerProof: "owner", pinEnvelope: null })
    expect(unpin.body.room.pinEnvelope).toBeNull()
  })

  it("rejects non-owners and bad envelopes", async () => {
    const { call, notOwner } = await setup()
    expect((await call("set-pin", { ...base, ownerProof: "owner", pinEnvelope: 5 })).status).toBe(400)
    notOwner()
    expect((await call("set-pin", { ...base, ownerProof: "x", pinEnvelope: "p" })).status).toBe(403)
  })
})

describe("named leave notices", () => {
  it("names participants who drop out of the presence window", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { internals, frames } = await setup()
      const core = internals.core as unknown as {
        touchParticipant(id: string, now: number): void
      }
      const presence = internals as unknown as { presenceFrame(now: number): unknown }
      core.touchParticipant("alice", 1_000_000)
      core.touchParticipant("bob", 1_000_000)
      expect(presence.presenceFrame(1_000_000)).toEqual({ t: "presence", participantCount: 2 })
      core.touchParticipant("alice", 1_040_000)
      expect(presence.presenceFrame(1_050_000)).toEqual({
        t: "presence",
        participantCount: 1,
        left: ["bob"],
      })
      expect(frames()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("timer notice text", () => {
  it("describes timed and never timers", () => {
    expect(timerNoticeText("Sam", 3_600_000)).toBe("Sam set messages to disappear after 1h.")
    expect(timerNoticeText("You", NEVER_EXPIRE_TTL_MS)).toBe(
      "You turned off disappearing messages.",
    )
    expect(timerNoticeText("Sam", NEVER_EXPIRE_TTL_MS, true)).toBe(
      "Sam turned off disappearing messages and kept the ones already here.",
    )
  })
})
