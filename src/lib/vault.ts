// Local “remembered rooms” vault. Stored in localStorage so a browser/PWA can
// rejoin after refresh. The invite key lives here in plaintext on the device
// only — this is the user's local key material, never sent anywhere.

const ROOMS_KEY = "vanish.rooms.v1"
const REMEMBER_KEY = "vanish.remember.v1"

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

function read(): RememberedRoom[] {
  try {
    const raw = localStorage.getItem(ROOMS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RememberedRoom[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(rooms: RememberedRoom[]): void {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms))
  } catch {
    /* storage may be unavailable (private mode); degrade gracefully */
  }
}

export const vault = {
  isRememberEnabled(): boolean {
    return localStorage.getItem(REMEMBER_KEY) !== "0"
  },
  setRememberEnabled(on: boolean): void {
    localStorage.setItem(REMEMBER_KEY, on ? "1" : "0")
    if (!on) write([])
  },
  list(): RememberedRoom[] {
    return read().sort((a, b) => b.lastUsed - a.lastUsed)
  },
  get(roomId: string): RememberedRoom | undefined {
    return read().find((r) => r.roomId === roomId)
  },
  save(room: RememberedRoom): void {
    if (!this.isRememberEnabled()) return
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
