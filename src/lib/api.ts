// Typed client for the Vanish Pages Functions API. All chat content sent here is
// already encrypted; these calls only move opaque envelopes + metadata.
import type {
  BroadcastRequest,
  CreateRoomRequest,
  ListMessagesRequest,
  ListMessagesResponse,
  PostMessageRequest,
  PruneRequest,
  PublicRoomState,
  ReactRequest,
  SignUploadRequest,
  SignUploadResponse,
  StoredMessage,
  UpdateInviteRequest,
  ValidateInviteRequest,
  ValidateInviteResponse,
} from "@shared/types"

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "ApiError"
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, (data.error as string) || res.statusText)
  return data as T
}

export const api = {
  createRoom(body: CreateRoomRequest) {
    return post<{ room: PublicRoomState }>("/api/rooms", body)
  },
  validateInvite(body: ValidateInviteRequest) {
    return post<ValidateInviteResponse>("/api/invites/validate", body)
  },
  updateInvite(body: UpdateInviteRequest) {
    return post<{ room: PublicRoomState }>("/api/invites/update", body)
  },
  session(body: { roomId: string; accessProof: string; participantId: string }) {
    return post<{ room: PublicRoomState }>("/api/session", body)
  },
  postMessage(body: PostMessageRequest) {
    return post<{ message: StoredMessage }>("/api/messages", body)
  },
  listMessages(body: ListMessagesRequest) {
    return post<ListMessagesResponse>("/api/messages/list", body)
  },
  prune(body: PruneRequest) {
    return post<{ removedIds: string[] }>("/api/prune", body)
  },
  react(body: ReactRequest) {
    return post<{ ok: boolean }>("/api/react", body)
  },
  broadcast(body: BroadcastRequest) {
    return post<{ ok: boolean }>("/api/broadcast", body)
  },
  signUpload(body: SignUploadRequest) {
    return post<SignUploadResponse>("/api/uploads/sign", body)
  },
  async deleteRoom(roomId: string, accessProof: string) {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessProof }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new ApiError(res.status, data.error || res.statusText)
    }
    return res.json() as Promise<{ ok: boolean }>
  },
  async uploadBlob(
    sign: SignUploadResponse,
    bytes: Uint8Array,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    // Use XHR so we can surface upload progress in the UI.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", sign.uploadUrl, true)
      xhr.setRequestHeader("x-vanish-token", sign.token)
      xhr.setRequestHeader("x-vanish-object", sign.objectKey)
      xhr.setRequestHeader("x-vanish-size", String(bytes.byteLength))
      xhr.setRequestHeader("x-vanish-expires", String(sign.expiresAt))
      xhr.setRequestHeader("content-type", "application/octet-stream")
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total)
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new ApiError(xhr.status, "upload failed"))
      xhr.onerror = () => reject(new ApiError(0, "network error"))
      xhr.send(bytes as unknown as XMLHttpRequestBodyInit)
    })
  },
  async downloadBlob(roomId: string, accessProof: string, objectKey: string): Promise<Uint8Array> {
    const res = await fetch("/api/uploads/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, accessProof, objectKey }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new ApiError(res.status, data.error || res.statusText)
    }
    return new Uint8Array(await res.arrayBuffer())
  },
}
