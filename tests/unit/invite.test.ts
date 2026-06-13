import { describe, expect, it } from "vitest"
import {
  buildInviteUrl,
  createInvite,
  INVITE_PREFIX,
  parseInviteFromUrl,
  parseInviteKey,
} from "@shared/invite"

describe("invite keys", () => {
  it("creates a parseable anonchat:v1 key", () => {
    const invite = createInvite()
    expect(invite.inviteKey.startsWith(INVITE_PREFIX)).toBe(true)
    const parsed = parseInviteKey(invite.inviteKey)
    expect(parsed?.roomId).toBe(invite.roomId)
    expect(parsed?.secretB64).toBe(invite.secretB64)
  })

  it("rejects malformed keys", () => {
    expect(parseInviteKey("")).toBeNull()
    expect(parseInviteKey("nope")).toBeNull()
    expect(parseInviteKey("anonchat:v1:onlyroom")).toBeNull()
    expect(parseInviteKey("anonchat:v2:room.secret")).toBeNull()
  })

  it("builds and parses a browser-safe invite URL", () => {
    const invite = createInvite()
    const url = buildInviteUrl("https://vanish.example.com", invite.inviteKey)
    // The invite key lives in the URL fragment so the secret is never sent to
    // the server (fragments are not transmitted in HTTP requests).
    expect(url).toContain("/#invite=")
    const parsed = parseInviteFromUrl(url)
    expect(parsed?.inviteKey).toBe(invite.inviteKey)
  })

  it("does not accept invite secrets from query parameters", () => {
    const invite = createInvite()
    const url = "https://vanish.example.com/?invite=" + encodeURIComponent(invite.inviteKey)
    expect(parseInviteFromUrl(url)).toBeNull()
  })
})
