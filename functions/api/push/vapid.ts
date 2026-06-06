import type { Env } from "../../types"
import { json } from "../../lib/do"

// GET /api/push/vapid — hand the client the VAPID public key it needs to create
// a Web Push subscription. Returns an empty key when push isn't configured, in
// which case the client quietly skips push registration.
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return json({ publicKey: env.VAPID_PUBLIC_KEY || "" })
}
