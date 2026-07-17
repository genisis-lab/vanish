import { afterEach, describe, expect, it, vi } from "vitest"
import { createInvite } from "@shared/invite"
import {
  buildDeviceTransfer,
  DEVICE_TRANSFER_TTL_MS,
  parseDeviceTransfer,
} from "@/lib/deviceTransfer"

const bundle = () => ({
  inviteKey: createInvite().inviteKey,
  username: "Ash",
  participantId: "participant",
  participantProof: "proof",
  ownerSecret: "owner",
})

afterEach(() => vi.useRealTimers())

describe("device transfer", () => {
  it("round-trips with the high-entropy pairing secret", async () => {
    const token = await buildDeviceTransfer(bundle(), "3s04V3Vuh8h4brn7RZ-8uA")
    const parsed = await parseDeviceTransfer(token, "3s04V3Vuh8h4brn7RZ-8uA")
    expect(parsed.username).toBe("Ash")
    expect(parsed.expiresAt).toBeGreaterThan(Date.now())
  })

  it("rejects a wrong pairing secret", async () => {
    const token = await buildDeviceTransfer(bundle(), "correct-high-entropy-secret")
    await expect(parseDeviceTransfer(token, "wrong-high-entropy-secret")).rejects.toThrow(
      /pairing secret|corrupt/i,
    )
  })

  it("rejects an expired code", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const token = await buildDeviceTransfer(bundle(), "correct-high-entropy-secret")
    vi.setSystemTime(Date.now() + DEVICE_TRANSFER_TTL_MS + 1)
    await expect(parseDeviceTransfer(token, "correct-high-entropy-secret")).rejects.toThrow(/expired/i)
  })
})
