import { describe, expect, it, vi } from "vitest"
import { RoomDurableObject } from "../../room-worker/src/RoomDurableObject"
import { NEVER_EXPIRE_TTL_MS } from "../../shared/constants"
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
  })
})
