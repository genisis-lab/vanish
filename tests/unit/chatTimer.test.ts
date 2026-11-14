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
  internals.verifyProof = async () => true
  internals.verifyParticipantProof = async () => true
  internals.core.createRoom({
    roomId: "room-1",
    accessProofHash: "hash",
    inviteExpiresAt: null,
    ttlMs: 24 * 3_600_000,
    now: Date.now(),
  })
  const setTimer = async (body: object) => {
    const res = await room.fetch(
      new Request("https://room/set-timer", { method: "POST", body: JSON.stringify(body) }),
    )
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  const frames = () => peer.send.mock.calls.map(([data]) => JSON.parse(data as string))
  return { internals, setTimer, frames, state }
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

describe("timer notice text", () => {
  it("describes timed and never timers", () => {
    expect(timerNoticeText("Sam", 3_600_000)).toBe("Sam set messages to disappear after 1h.")
    expect(timerNoticeText("You", NEVER_EXPIRE_TTL_MS)).toBe(
      "You turned off disappearing messages.",
    )
  })
})
