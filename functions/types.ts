// Bindings available to Vanish Pages Functions.
export interface Env {
  /** Durable Object namespace bound to the companion Worker's RoomDurableObject. */
  ROOM: DurableObjectNamespace
  /** R2 bucket holding only encrypted media bytes. */
  MEDIA: R2Bucket
  /** HMAC secret used to sign one-time upload tokens. */
  UPLOAD_SECRET?: string
  APP_NAME?: string
  /** VAPID public key (base64url), served to clients so they can subscribe to Web Push. */
  VAPID_PUBLIC_KEY?: string
}
