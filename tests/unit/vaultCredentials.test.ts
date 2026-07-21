import { beforeEach, describe, expect, it, vi } from "vitest"

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe("encrypted device vault credentials", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    })
    vi.resetModules()
  })

  it("encrypts owner, participant, and signing credentials together", async () => {
    const { vault } = await import("@/lib/vault")
    vault.setRememberEnabled(true)
    vault.save({
      roomId: "room-id",
      inviteKey: "invite-secret",
      username: "Ash",
      participantId: "participant",
      participantProof: "participant-secret",
      ownerSecret: "owner-secret",
      signing: { priv: "private-signing-key", pub: "public-signing-key" },
      lastUsed: 1,
    })

    await vault.setPassphrase("a strong device passphrase")
    const encrypted = localStorage.getItem("vanish.rooms.enc.v1") ?? ""
    expect(localStorage.getItem("vanish.rooms.v1")).toBeNull()
    expect(encrypted).not.toContain("invite-secret")
    expect(encrypted).not.toContain("participant-secret")
    expect(encrypted).not.toContain("owner-secret")
    expect(encrypted).not.toContain("private-signing-key")

    vault.lock()
    expect(vault.list()).toEqual([])
    expect(await vault.unlock("a strong device passphrase")).toBe(true)
    expect(vault.get("room-id")).toMatchObject({
      participantProof: "participant-secret",
      ownerSecret: "owner-secret",
      signing: { priv: "private-signing-key", pub: "public-signing-key" },
    })
  })

  it("rejects weak vault passphrases", async () => {
    const { vault } = await import("@/lib/vault")
    await expect(vault.setPassphrase("short")).rejects.toThrow(/at least 12/i)
    await expect(vault.setDuressPassphrase("short")).rejects.toThrow(/at least 8/i)
  })
})
