// Local "remembered rooms" vault. Stored in localStorage so a browser/PWA can
// rejoin after refresh. The invite key is the user's local key material and is
// never sent anywhere.
//
// Optional passphrase lock: when a passphrase is set, the vault blob is
// encrypted at rest with an AES-GCM key derived from the passphrase (PBKDF2,
// 210k iterations). Until unlocked in-memory, saved rooms are inaccessible — so
// device access alone no longer exposes your rooms/keys.
//
// Optional duress passphrase: a second passphrase that, when entered at the
// unlock screen, instantly wipes the saved rooms on this device and opens an
// empty vault instead — for situations where you're forced to unlock.

import { fromBase64Url, toBase64Url, utf8 } from "@shared/crypto"

const ROOMS_KEY = "vanish.rooms.v1" // plaintext rooms (when no passphrase)
const REMEMBER_KEY = "vanish.remember.v1"
const ENC_KEY = "vanish.rooms.enc.v1" // encrypted rooms blob (when passphrase set)
const LOCK_KEY = "vanish.lock.v1" // base64url(salt); presence => passphrase enabled
const DURESS_KEY = "vanish.duress.v1" // base64url(salt).base64url(verifier)

export interface RememberedRoom {
  roomId: string
  inviteKey: string
  username: string
  participantId: string
  label?: string
  lastUsed: number
  /** Safety number the user explicitly marked as verified, if any. */
  verifiedSafetyNumber?: string
  /** Pinned rooms sort to the top of the home list. */
  pinned?: boolean
  /** Muted rooms make no sound and show no pop-up alerts on this device. */
  muted?: boolean
}

// ---- in-memory unlocked state ----
let mem: RememberedRoom[] | null = null
let vaultKey: CryptoKey | null = null
let unlocked = false

function hasPassphrase(): boolean {
  try {
    return !!localStorage.getItem(LOCK_KEY)
  } catch {
    return false
  }
}

function readPlain(): RememberedRoom[] {
  try {
    const raw = localStorage.getItem(ROOMS_KEY)
    const parsed = raw ? (JSON.parse(raw) as RememberedRoom[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function read(): RememberedRoom[] {
  if (hasPassphrase()) return unlocked && mem ? mem.slice() : []
  return readPlain()
}

function write(rooms: RememberedRoom[]): void {
  if (hasPassphrase()) {
    if (!unlocked) return // locked: cannot persist without the key
    mem = rooms
    void persistEncrypted()
    return
  }
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms))
  } catch {
    /* storage may be unavailable (private mode); degrade gracefully */
  }
}

// ---- passphrase crypto ----
function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey(
    "raw",
    utf8(passphrase) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  )
  return subtle().deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 210_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

// PBKDF2-derived verifier for the duress passphrase. Only a salted hash is
// stored; the passphrase itself never touches storage.
async function duressVerifier(passphrase: string, salt: Uint8Array): Promise<string> {
  const base = await subtle().importKey(
    "raw",
    utf8(passphrase) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 210_000, hash: "SHA-256" },
    base,
    256,
  )
  return toBase64Url(new Uint8Array(bits))
}

async function encryptRooms(key: CryptoKey, rooms: RememberedRoom[]): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const pt = utf8(JSON.stringify(rooms))
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, pt as unknown as BufferSource),
  )
  const out = new Uint8Array(12 + ct.length)
  out.set(iv, 0)
  out.set(ct, 12)
  return toBase64Url(out)
}

async function decryptRooms(key: CryptoKey, blobB64: string): Promise<RememberedRoom[]> {
  const blob = fromBase64Url(blobB64)
  const iv = blob.slice(0, 12)
  const ct = blob.slice(12)
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    ct as unknown as BufferSource,
  )
  const arr = JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as RememberedRoom[]
  return Array.isArray(arr) ? arr : []
}

async function persistEncrypted(): Promise<void> {
  if (!vaultKey || !mem) return
  try {
    localStorage.setItem(ENC_KEY, await encryptRooms(vaultKey, mem))
  } catch {
    /* ignore */
  }
}

export const vault = {
  isRememberEnabled(): boolean {
    try {
      return localStorage.getItem(REMEMBER_KEY) !== "0"
    } catch {
      return false
    }
  },
  setRememberEnabled(on: boolean): void {
    try {
      localStorage.setItem(REMEMBER_KEY, on ? "1" : "0")
    } catch {
      /* ignore */
    }
    if (!on) {
      write([])
      try {
        localStorage.removeItem(ROOMS_KEY)
        localStorage.removeItem(ENC_KEY)
      } catch {
        /* ignore */
      }
    }
  },

  // ----- passphrase lock -----
  hasPassphrase(): boolean {
    return hasPassphrase()
  },
  isLocked(): boolean {
    return hasPassphrase() && !unlocked
  },
  async unlock(passphrase: string): Promise<boolean> {
    if (!hasPassphrase()) return true
    // Duress check first: the panic passphrase wipes saved rooms and opens an
    // empty vault, indistinguishable from a normal unlock.
    try {
      const duress = localStorage.getItem(DURESS_KEY)
      if (duress) {
        const dot = duress.indexOf(".")
        if (dot > 0) {
          const salt = fromBase64Url(duress.slice(0, dot))
          const expected = duress.slice(dot + 1)
          if ((await duressVerifier(passphrase, salt)) === expected) {
            try {
              localStorage.removeItem(ENC_KEY)
              localStorage.removeItem(ROOMS_KEY)
            } catch {
              /* ignore */
            }
            const saltB64 = localStorage.getItem(LOCK_KEY)
            vaultKey = saltB64 ? await deriveVaultKey(passphrase, fromBase64Url(saltB64)) : null
            mem = []
            unlocked = true
            return true
          }
        }
      }
    } catch {
      /* fall through to the normal unlock path */
    }
    try {
      const saltB64 = localStorage.getItem(LOCK_KEY)
      if (!saltB64) return true
      const key = await deriveVaultKey(passphrase, fromBase64Url(saltB64))
      const blob = localStorage.getItem(ENC_KEY)
      mem = blob ? await decryptRooms(key, blob) : []
      vaultKey = key
      unlocked = true
      return true
    } catch {
      return false
    }
  },
  lock(): void {
    mem = null
    vaultKey = null
    unlocked = false
  },
  async setPassphrase(passphrase: string): Promise<void> {
    const current = hasPassphrase() ? (unlocked && mem ? mem : []) : readPlain()
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    vaultKey = await deriveVaultKey(passphrase, salt)
    unlocked = true
    mem = current
    try {
      localStorage.setItem(LOCK_KEY, toBase64Url(salt))
    } catch {
      /* ignore */
    }
    await persistEncrypted()
    try {
      localStorage.removeItem(ROOMS_KEY)
    } catch {
      /* ignore */
    }
  },
  async removePassphrase(passphrase: string): Promise<boolean> {
    if (!hasPassphrase()) return true
    const okUnlock = unlocked || (await this.unlock(passphrase))
    if (!okUnlock) return false
    const rooms = mem ?? []
    try {
      localStorage.removeItem(LOCK_KEY)
      localStorage.removeItem(ENC_KEY)
      localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms))
    } catch {
      /* ignore */
    }
    vaultKey = null
    unlocked = false
    mem = null
    return true
  },

  // ----- duress passphrase -----
  hasDuress(): boolean {
    try {
      return !!localStorage.getItem(DURESS_KEY)
    } catch {
      return false
    }
  },
  async setDuressPassphrase(passphrase: string): Promise<void> {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const verifier = await duressVerifier(passphrase, salt)
    try {
      localStorage.setItem(DURESS_KEY, toBase64Url(salt) + "." + verifier)
    } catch {
      /* ignore */
    }
  },
  removeDuressPassphrase(): void {
    try {
      localStorage.removeItem(DURESS_KEY)
    } catch {
      /* ignore */
    }
  },

  // ----- room records -----
  list(): RememberedRoom[] {
    return read().sort(
      (a, b) =>
        Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.lastUsed - a.lastUsed,
    )
  },
  get(roomId: string): RememberedRoom | undefined {
    return read().find((r) => r.roomId === roomId)
  },
  save(room: RememberedRoom): void {
    if (!this.isRememberEnabled()) return
    if (this.isLocked()) return
    const existing = read().find((r) => r.roomId === room.roomId)
    const rooms = read().filter((r) => r.roomId !== room.roomId)
    // Preserve per-room flags (pin/mute/verified) across re-saves.
    rooms.push({
      pinned: existing?.pinned,
      muted: existing?.muted,
      verifiedSafetyNumber: existing?.verifiedSafetyNumber,
      ...room,
    })
    write(rooms)
  },
  touch(roomId: string): void {
    const rooms = read()
    const r = rooms.find((x) => x.roomId === roomId)
    if (r) {
      r.lastUsed = Date.now()
      write(rooms)
    }
  },
  setVerified(roomId: string, safetyNumber: string): void {
    const rooms = read()
    const r = rooms.find((x) => x.roomId === roomId)
    if (r) {
      r.verifiedSafetyNumber = safetyNumber
      write(rooms)
    }
  },
  setPinned(roomId: string, pinned: boolean): void {
    const rooms = read()
    const r = rooms.find((x) => x.roomId === roomId)
    if (r) {
      r.pinned = pinned
      write(rooms)
    }
  },
  setMuted(roomId: string, muted: boolean): void {
    const rooms = read()
    const r = rooms.find((x) => x.roomId === roomId)
    if (r) {
      r.muted = muted
      write(rooms)
    }
  },
  forget(roomId: string): void {
    write(read().filter((r) => r.roomId !== roomId))
  },
}
