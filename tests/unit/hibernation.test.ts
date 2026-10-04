import { describe, it, expect, vi } from "vitest"
import { RoomDurableObject } from "../../room-worker/src/RoomDurableObject"

describe("room socket hibernation", () => {
  it("restores sockets on wake and removes closed connections from broadcasts", async () => {
    const socket = (participantId: string) => ({
      deserializeAttachment: () => ({ participantId }), send: vi.fn(), close: vi.fn(),
    })
    const first = socket("first"), second = socket("second")
    let ready: Promise<unknown> = Promise.resolve()
    const state = {
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); return ready },
      getWebSockets: () => [first, second],
      storage: { get: vi.fn().mockResolvedValue(undefined), getAlarm: vi.fn().mockResolvedValue(null), setAlarm: vi.fn() },
    }
    const room = new RoomDurableObject(state as unknown as DurableObjectState, {} as any)
    await ready
    room.webSocketClose(first as unknown as WebSocket, 1000)
    expect(first.close).toHaveBeenCalledWith(1000)
    expect(first.send).not.toHaveBeenCalled()
    expect(second.send).toHaveBeenCalledTimes(1)
    room.webSocketError(second as unknown as WebSocket)
    expect(second.close).toHaveBeenCalledWith(1011, "Connection error")
    expect(second.send).toHaveBeenCalledTimes(1)
  })

  it("closes sockets without restorable session metadata", async () => {
    const ws = { deserializeAttachment: () => null, close: vi.fn() }
    let ready: Promise<unknown> = Promise.resolve()
    const state = {
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); return ready },
      getWebSockets: () => [ws],
      storage: { get: vi.fn().mockResolvedValue(undefined) },
    }
    new RoomDurableObject(state as unknown as DurableObjectState, {} as any)
    await ready
    expect(ws.close).toHaveBeenCalledWith(1011, "Missing session")
  })
})
