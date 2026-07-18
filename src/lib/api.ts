// Typed client for the Vanish Pages Functions API. All chat content sent here is
// already encrypted; these calls only move opaque envelopes + metadata.
import type {
  BroadcastRequest,
  CreateRoomRequest,
  DeleteOwnMessageRequest,
  EditMessageRequest,
  ListMessagesRequest,
  ListMessagesResponse,
  MultipartCreateResponse,
  MultipartUploadedPart,
  OwnerActionRequest,
  PostMessageRequest,
  PruneRequest,
  PublicRoomState,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  ReactRequest,
  SetTopicRequest,
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

// Turn raw HTTP failures into something a human wants to read. The server's
// own message wins when it sent one; these are sensible fallbacks per status.
export function friendlyError(status: number, message: string): string {
  switch (status) {
    case 429:
      return "You're going a little fast \u2014 wait a moment and try again."
    case 413:
      return "That file is too large to send."
    case 410:
      return "This room no longer exists."
    case 403:
      return "Access denied \u2014 the invite key may be wrong."
    case 0:
      return "Network error \u2014 check your connection and try again."
    default:
      return message
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const raw = (data.error as string) || res.statusText
    throw new ApiError(res.status, friendlyError(res.status, raw))
  }
  return data as T
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const raw = (data.error as string) || res.statusText
    throw new ApiError(res.status, friendlyError(res.status, raw))
  }
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
  setTopic(body: SetTopicRequest) {
    return post<{ room: PublicRoomState }>("/api/rooms/topic", body)
  },
  ownerAction(body: OwnerActionRequest) {
    return post<{ room?: PublicRoomState; removedIds?: string[]; ok?: boolean }>(
      "/api/rooms/owner",
      body,
    )
  },
  session(body: {
    roomId: string
    accessProof: string
    participantId: string
    participantProof: string
  }) {
    return post<{ room: PublicRoomState }>("/api/session", body)
  },
  postMessage(body: PostMessageRequest) {
    return post<{ message: StoredMessage }>("/api/messages", body)
  },
  editMessage(body: EditMessageRequest) {
    return post<{ message: StoredMessage }>("/api/messages/edit", body)
  },
  deleteOwnMessage(body: DeleteOwnMessageRequest) {
    return post<{ message: StoredMessage }>("/api/messages/delete", body)
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
  pushVapid() {
    return get<{ publicKey: string }>("/api/push/vapid")
  },
  pushSubscribe(body: PushSubscribeRequest) {
    return post<{ ok: boolean }>("/api/push/subscribe", body)
  },
  pushUnsubscribe(body: PushUnsubscribeRequest) {
    return post<{ ok: boolean }>("/api/push/unsubscribe", body)
  },
  signUpload(body: SignUploadRequest) {
    return post<SignUploadResponse>("/api/uploads/sign", body)
  },
  async deleteRoom(roomId: string, accessProof: string, ownerProof: string) {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessProof, ownerProof }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new ApiError(res.status, friendlyError(res.status, data.error || res.statusText))
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
          : reject(new ApiError(xhr.status, friendlyError(xhr.status, "upload failed")))
      xhr.onerror = () => reject(new ApiError(0, friendlyError(0, "network error")))
      xhr.send(bytes as unknown as XMLHttpRequestBodyInit)
    })
  },
  async createMultipartUpload(sign: SignUploadResponse): Promise<MultipartCreateResponse> {
    const res = await fetch(`${sign.uploadUrl}/create`, {
      method: "POST",
      headers: uploadHeaders(sign),
    })
    return uploadResponseJson<MultipartCreateResponse>(res, "could not start upload")
  },
  async uploadMultipartPart(
    sign: SignUploadResponse,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<MultipartUploadedPart> {
    return new Promise<MultipartUploadedPart>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open("PUT", `${sign.uploadUrl}/part`, true)
      for (const [name, value] of Object.entries(uploadHeaders(sign))) xhr.setRequestHeader(name, value)
      xhr.setRequestHeader("x-vanish-upload-id", uploadId)
      xhr.setRequestHeader("x-vanish-part", String(partNumber))
      xhr.setRequestHeader("content-type", "application/octet-stream")
      xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.total || bytes.byteLength)
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ApiError(xhr.status, friendlyError(xhr.status, "part upload failed")))
          return
        }
        try {
          resolve(JSON.parse(xhr.responseText) as MultipartUploadedPart)
        } catch {
          reject(new ApiError(xhr.status, "Invalid multipart response"))
        }
      }
      xhr.onerror = () => reject(new ApiError(0, friendlyError(0, "network error")))
      xhr.send(bytes as unknown as XMLHttpRequestBodyInit)
    })
  },
  async completeMultipartUpload(
    sign: SignUploadResponse,
    uploadId: string,
    parts: MultipartUploadedPart[],
  ): Promise<void> {
    const res = await fetch(`${sign.uploadUrl}/complete`, {
      method: "POST",
      headers: {
        ...uploadHeaders(sign),
        "x-vanish-upload-id": uploadId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ parts }),
    })
    await uploadResponseJson(res, "could not complete upload")
  },
  async abortMultipartUpload(sign: SignUploadResponse, uploadId: string): Promise<void> {
    await fetch(`${sign.uploadUrl}/abort`, {
      method: "DELETE",
      headers: { ...uploadHeaders(sign), "x-vanish-upload-id": uploadId },
    }).catch(() => undefined)
  },
  async downloadBlob(roomId: string, accessProof: string, objectKey: string): Promise<Uint8Array> {
    const res = await fetch("/api/uploads/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, accessProof, objectKey }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new ApiError(res.status, friendlyError(res.status, data.error || res.statusText))
    }
    return new Uint8Array(await res.arrayBuffer())
  },
  async downloadBlobRange(
    roomId: string,
    accessProof: string,
    objectKey: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const res = await fetch("/api/uploads/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, accessProof, objectKey, offset, length }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new ApiError(res.status, friendlyError(res.status, data.error || res.statusText))
    }
    return new Uint8Array(await res.arrayBuffer())
  },
}

function uploadHeaders(sign: SignUploadResponse): Record<string, string> {
  return {
    "x-vanish-token": sign.token,
    "x-vanish-object": sign.objectKey,
    "x-vanish-size": String(sign.size),
    "x-vanish-expires": String(sign.expiresAt),
  }
}

async function uploadResponseJson<T = unknown>(response: Response, fallback: string): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) {
    throw new ApiError(response.status, friendlyError(response.status, data.error || fallback))
  }
  return data
}
