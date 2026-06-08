// Self-contained Web Push (RFC 8291 "aes128gcm" payload encryption + VAPID /
// RFC 8292 request signing), implemented with WebCrypto only so it runs inside
// a Cloudflare Worker / Durable Object with no Node dependencies.
//
// PRIVACY: the server only ever holds ciphertext, so the payloads sent from
// here never contain message content — just an opaque "new message" ping. The
// client decrypts in-app after the notification is tapped.

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface VapidKeys {
  /** base64url of the 65-byte uncompressed P-256 public point. */
  publicKey: string
  /** base64url of the 32-byte private scalar. */
  privateKey: string
  /** Contact URI, e.g. "mailto:you@example.com". */
  subject: string
}

// TS 5.7+ types Uint8Array as Uint8Array<ArrayBufferLike>, whose backing buffer
// may be a SharedArrayBuffer. WebCrypto (BufferSource) and fetch (BodyInit)
// expect an ArrayBuffer-backed view, so we narrow with a cast at the boundary.
// Every Uint8Array we pass here is allocated locally and ArrayBuffer-backed.
function asBufferSource(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource
}

const NULL = new Uint8Array([0])
const encoder = new TextEncoder()

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/")
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let len = 0
  for (const a of arrs) len += a.length
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", asBufferSource(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, asBufferSource(data)))
}

// Single-block HKDF (every output we need here is <= 32 bytes).
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm)
  const t1 = await hmac(prk, concat(info, new Uint8Array([1])))
  return t1.slice(0, length)
}

// RFC 8291 §3.4 + RFC 8188 §2: encrypt `plaintext` into a single aes128gcm
// record addressed to the subscription's public key.
async function encryptPayload(sub: PushSubscription, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(sub.keys.p256dh)
  const authSecret = b64urlToBytes(sub.keys.auth)

  const asPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asPair.publicKey))

  const uaKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPair.privateKey, 256),
  )

  // Derive the input keying material bound to both public keys.
  const keyInfo = concat(encoder.encode("WebPush: info"), NULL, uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32)

  // Content encryption key + nonce from a fresh random salt.
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, concat(encoder.encode("Content-Encoding: aes128gcm"), NULL), 16)
  const nonce = await hkdf(salt, ikm, concat(encoder.encode("Content-Encoding: nonce"), NULL), 12)

  // Single record: plaintext followed by the 0x02 last-record delimiter.
  const record = concat(plaintext, new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey("raw", asBufferSource(cek), { name: "AES-GCM" }, false, ["encrypt"])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBufferSource(nonce), tagLength: 128 }, aesKey, asBufferSource(record)),
  )

  // aes128gcm header: salt(16) | rs(4 BE) | idlen(1) | keyid(asPublic) | ciphertext
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096, false)
  const idlen = new Uint8Array([asPublic.length])
  return concat(salt, rs, idlen, asPublic, ciphertext)
}

async function importVapidKey(vapid: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlToBytes(vapid.publicKey)
  const d = b64urlToBytes(vapid.privateKey)
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: bytesToB64url(d),
    ext: true,
  }
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
}

// RFC 8292 VAPID Authorization header: a signed JWT plus the raw public key.
async function vapidAuthHeader(endpoint: string, vapid: VapidKeys): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = bytesToB64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60
  const payload = bytesToB64url(encoder.encode(JSON.stringify({ aud, exp, sub: vapid.subject })))
  const signingInput = header + "." + payload
  const key = await importVapidKey(vapid)
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, asBufferSource(encoder.encode(signingInput))),
  )
  const jwt = signingInput + "." + bytesToB64url(sig)
  return "vapid t=" + jwt + ", k=" + vapid.publicKey
}

/**
 * Deliver a single Web Push message. Returns the push service HTTP status
 * (201 on success; 404/410 mean the subscription is gone and should be dropped).
 */
export async function sendWebPush(
  sub: PushSubscription,
  payload: string,
  vapid: VapidKeys,
  ttlSeconds = 60,
): Promise<number> {
  const body = await encryptPayload(sub, encoder.encode(payload))
  const auth = await vapidAuthHeader(sub.endpoint, vapid)
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "high",
      Authorization: auth,
    },
    body: body as unknown as BodyInit,
  })
  return res.status
}
