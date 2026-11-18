// @vitest-environment happy-dom
// End-to-end checks of how a room stays in sync, against a fake server built on
// the real RoomCore: the reply to this device's own write must not make it skip
// a message someone else sent a moment earlier, a reconnecting socket must
// fetch what was sent while it was away, and an answer that was in flight must
// not delete a message that arrived after it was put together.
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { RoomCore } from "@shared/roomCore"
import type { ListMessagesRequest, StoredMessage } from "@shared/types"
import { useRoom, type RoomController } from "../../src/lib/useRoom"
import type { RoomSession } from "../../src/lib/session"

const ROOM = "r".repeat(22)

const server = vi.hoisted(() => ({
  core: null as unknown as RoomCore,
  // When set, list answers are put together at call time but held until released.
  hold: null as null | Promise<void>,
  lists: [] as ListMessagesRequest[],
}))

const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

vi.mock("../../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/api")>()
  return {
    ...real,
    api: {
      session: async () => json({ room: server.core.publicState(Date.now()) }),
      broadcast: async () => ({ ok: true }),
      readMessages: async () => ({ ok: true }),
      listMessages: async (req: ListMessagesRequest) => {
        server.lists.push(req)
        const now = Date.now()
        server.core.sweep(now)
        let messages = server.core.list(now)
        const currentMessageIds = messages.map((m) => m.id)
        const since = req.since
        if (typeof since === "number") {
          messages = messages.filter((m) => m.createdAt > since || (m.updatedAt ?? 0) > since)
        }
        const answer = json({
          messages,
          currentMessageIds,
          room: server.core.publicState(now),
          serverTime: now,
          signals: [],
        })
        if (server.hold) await server.hold
        return answer
      },
      postMessage: async (req: { message: { id: string; participantId: string; envelope: string } }) => {
        const message = server.core.addMessage(
          { id: req.message.id, participantId: req.message.participantId, envelope: req.message.envelope, kind: "text" },
          Date.now(),
        )
        return json({ message })
      },
      setTimer: async (req: { participantId: string; ttlMs: number; notice: { id: string; envelope: string } }) => {
        const now = Date.now()
        server.core.updateRoom({ ttlMs: req.ttlMs })
        const message = server.core.addMessage(
          { id: req.notice.id, participantId: req.participantId, envelope: req.notice.envelope, kind: "system", ttlMs: req.ttlMs },
          now,
        )
        return json({ room: server.core.publicState(now), message, keptIds: [] })
      },
    },
  }
})
vi.mock("../../src/lib/messages", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/messages")>()
  return {
    ...real,
    encodeText: async (_s: unknown, _id: string, text: string) => text,
    encodeSystem: async () => "timer-notice",
    decodeMessage: async (session: RoomSession, m: StoredMessage) => ({
      id: m.id,
      participantId: m.participantId,
      kind: m.kind,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      mine: m.participantId === session.participantId,
      username: m.participantId,
      text: m.envelope,
      reactions: [],
    }),
  }
})
vi.mock("../../src/lib/vault", () => ({ vault: { get: () => undefined } }))
vi.mock("../../src/lib/notify", () => ({
  ensureNotificationPrompt() {},
  notificationsEnabled: () => false,
  showMessageNotification: async () => {},
}))
vi.mock("../../shared/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/crypto")>()),
  encryptString: async () => "encrypted",
  decryptString: async () => "Guest",
}))

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSocket.instances.push(this)
  }
  send() {}
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
}

const session = {
  invite: { roomId: ROOM },
  keys: { accessProof: "proof" },
  participantId: "bea",
  participantProof: "bea-proof",
  username: "Bea",
} as RoomSession

let root: Root | undefined
let host: HTMLDivElement | undefined
let room!: RoomController

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  server.core = new RoomCore()
  server.core.createRoom({ roomId: ROOM, accessProofHash: "h", inviteExpiresAt: null, ttlMs: 3_600_000, now: Date.now() })
  server.hold = null
  server.lists = []
  FakeSocket.instances = []
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount() {
  function Probe() {
    room = useRoom(session)
    return null
  }
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(Probe)))
}

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const texts = () => room.messages.filter((m) => m.kind !== "system").map((m) => m.text)
const fromAsh = (id: string, text: string) =>
  server.core.addMessage({ id, participantId: "ash", envelope: text, kind: "text" }, Date.now())

it("still fetches a message sent just before this device changed the timer", async () => {
  // No socket locally, so the room polls, as in the original report.
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("no socket") } })
  await mount()
  await wait(1_000)
  expect(room.connState).toBe("polling")

  fromAsh("m1", "sent right before the timer change")
  await wait(300)
  // Bea changes the timer before her next poll. The reply carries the notice,
  // stamped after Ash's message.
  await act(async () => { await room.setMessageTimer(300_000) })
  await wait(2_000)

  expect(texts()).toContain("sent right before the timer change")
})

it("still fetches a message sent just before this device's own message", async () => {
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("no socket") } })
  await mount()
  await wait(1_000)
  fromAsh("m1", "from Ash")
  await wait(200)
  await act(async () => { await room.sendText("from Bea") })
  await wait(2_000)
  expect(texts()).toEqual(["from Ash", "from Bea"])
})

it("fetches what was sent while the socket was reconnecting", async () => {
  vi.stubGlobal("WebSocket", FakeSocket)
  await mount()
  await act(async () => FakeSocket.instances[0].open())
  await wait(100)
  expect(room.connState).toBe("live")

  // The socket drops; the room polls while it reconnects.
  await act(async () => FakeSocket.instances[0].close())
  expect(room.connState).toBe("polling")
  await wait(1_050)
  // Sent after the last poll, while the new socket is still connecting.
  fromAsh("m2", "sent during the reconnect")
  await wait(100)
  const next = FakeSocket.instances[1]
  expect(next).toBeDefined()
  await act(async () => next.open())
  await wait(3_000)

  expect(room.connState).toBe("live")
  expect(texts()).toContain("sent during the reconnect")
})

it("keeps live messages that arrive while a catch-up is in flight", async () => {
  vi.stubGlobal("WebSocket", FakeSocket)
  await mount()
  await wait(100)
  // The catch-up for this socket is put together now but answers late.
  let release!: () => void
  server.hold = new Promise<void>((resolve) => { release = resolve })
  await act(async () => FakeSocket.instances[0].open())
  await wait(50)
  const live = fromAsh("m3", "arrived live")
  await act(async () => FakeSocket.instances[0].push({ t: "message", message: json(live) }))
  expect(texts()).toContain("arrived live")
  server.hold = null
  await act(async () => release())
  await wait(100)
  expect(texts()).toContain("arrived live")
})

it("does not lose its own message to a poll answer that was already in flight", async () => {
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("no socket") } })
  await mount()
  await wait(1_000)
  let release!: () => void
  server.hold = new Promise<void>((resolve) => { release = resolve })
  // A poll is put together now, before Bea's message exists, and answers late.
  await wait(1_000)
  await act(async () => { await room.sendText("mine") })
  expect(texts()).toEqual(["mine"])
  server.hold = null
  await act(async () => release())
  await wait(2_500)
  expect(texts()).toEqual(["mine"])
})

it("asks for whole history only once and stops reaching back after catching up", async () => {
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("no socket") } })
  fromAsh("m0", "history")
  await mount()
  await wait(3_000)
  expect(texts()).toEqual(["history"])
  const full = server.lists.filter((r) => r.since === undefined)
  expect(full).toHaveLength(1)
  // Later polls reach back only a moment, not to the start of the room.
  const last = server.lists[server.lists.length - 1]
  expect(last.since).toBeGreaterThan(Date.now() - 2_000)
})
