// Local "remembered rooms" vault. Stored in localStorage so a browser/PWA can
// rejoin after refresh. The invite key is the user's local key material and is
// never sent anywhere.
//
// Optional passphrase lock: when a passphrase is set, the vault blob is
// encrypted at rest with an AES-GCM key derived from the passphrase (PBKDF2,
// 210k iterations). Until unlocked in-memory, saved rooms are inaccessible — so
// device access alone no longer exposes your rooms/keys.

import { fromBase64Url, toBase64Url, utf8 } from "@shared/crypto"

const ROOMS_KEY = "vanish.rooms.v1" // plaintext rooms (when no passphrase)
const REMEMBER_KEY = "vanish.remember.v1"
const ENC_KEY = "vanish.rooms.enc.v1" // encrypted rooms blob (when passphrase set)
const LOCK_KEY = "vanish.lock.v1" // base64url(salt); presence => passphrase enabled

export interface RememberedRoom {
  roomId: string
  inviteKey: string
  username: string
  participantId: string
  label?: string
  lastUsed: number
  /** Safety number the user explicitly marked as verified, if any. */
  verifiedSafetyNumber?: string
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

  // ----- room records -----
  list(): RememberedRoom[] {
    return read().sort((a, b) => b.lastUsed - a.lastUsed)
  },
  get(roomId: string): RememberedRoom | undefined {
    return read().find((r) => r.roomId === roomId)
  },
  save(room: RememberedRoom): void {
    if (!this.isRememberEnabled()) return
    if (this.isLocked()) return
    const rooms = read().filter((r) => r.roomId !== room.roomId)
    rooms.push(room)
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
  forget(roomId: string): void {
    write(read().filter((r) => r.roomId !== roomId))
  },
}
