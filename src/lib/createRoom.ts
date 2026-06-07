// Client-side room creation: generates the invite, derives keys, registers the
// access-proof hash with the server (which never sees the secret) and returns a
// ready session. The creator also mints an owner secret (stored locally only)
// and registers its hash so they — and only they — hold owner controls.
import type { InviteExpiryOption } from "@shared/types"
import { inviteExpiryToMs } from "@shared/constants"
import { createInvite } from "@shared/invite"
import { api } from "./api"
import { generateOwnerSecret, ownerKeyHash, saveOwnerSecret } from "./owner"
import { buildSession, type RoomSession } from "./session"

export interface CreateRoomOptions {
  username: string
  inviteExpiry: InviteExpiryOption
  ttlMs: number
  burnAfterRead: boolean
  /** Whole-room auto-destruct lifetime in ms from creation. 0/undefined = off. */
  roomLifetimeMs?: number
}

export async function createRoom(opts: CreateRoomOptions): Promise<RoomSession> {
  const invite = createInvite()
  // Mint + persist the owner secret BEFORE building the session so buildSession
  // can load it and mark this device as the room owner.
  const ownerSecret = generateOwnerSecret()
  saveOwnerSecret(invite.roomId, ownerSecret)
  const session = await buildSession(invite, opts.username)
  const now = Date.now()
  const inviteExpiresAt = inviteExpiryToMs(opts.inviteExpiry, now)
  await api.createRoom({
    roomId: invite.roomId,
    accessProofHash: session.keys.accessProofHash,
    inviteExpiry: opts.inviteExpiry,
    ttlMs: opts.ttlMs,
    burnAfterRead: opts.burnAfterRead,
    roomLifetimeMs: opts.roomLifetimeMs,
    ownerKeyHash: await ownerKeyHash(ownerSecret),
  })
  void inviteExpiresAt
  return session
}
