import { describe, expect, it } from "vitest"
import { RoomCore } from "@shared/roomCore"
import { NEVER_EXPIRE_TTL_MS } from "@shared/constants"

describe("switching a live room to Never", () => {
  it("keeps new messages forever and survives a reload", () => {
    const now = 1_000_000
    const core = new RoomCore()
    core.createRoom({ roomId: "r".repeat(22), accessProofHash: "h", inviteExpiresAt: null, ttlMs: 3_600_000, now })
    core.addMessage({ id: "old", participantId: "p", envelope: "e", kind: "text" }, now)
    core.updateRoom({ ttlMs: NEVER_EXPIRE_TTL_MS })
    // DO restart / hibernation wake
    const reloaded = new RoomCore(core.toSnapshot())
    expect(reloaded.publicState(now)!.defaultTtlMs).toBe(0)
    const fresh = reloaded.addMessage({ id: "new", participantId: "p", envelope: "e", kind: "text" }, now + 1)
    expect(fresh.expiresAt).toBeNull()
    reloaded.sweep(now + 365 * 86_400_000)
    expect(reloaded.hasMessage("new")).toBe(true)
  })
})
