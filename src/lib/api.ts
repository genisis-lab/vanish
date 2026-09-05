// Typed client for the Vanish Pages Functions API. All chat content sent here is
// already encrypted; these calls only move opaque envelopes + metadata.
import type {
  BroadcastRequest,
  ConsumeMessagesRequest,
  ReadReceiptRequest,
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
  ReportMessageRequest,
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

export const REQUEST_TIMEOUT_MS = 30_000

export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  )
  try {
    const res = await fetch(path, { ...init, signal: controller.signal })
    const data = (await res.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error
      throw new ApiError(
        res.status,
        res.ok
          ? "The server returned an invalid response. Try again."
          : friendlyError(res.status, res.statusText || "The service is temporarily unavailable."),
      )
    })) as Record<string, unknown>
    if (!res.ok)
      throw new ApiError(
        res.status,
        friendlyError(res.status, typeof data.error === "string" ? data.error : res.statusText),
      )
    return data as T
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError")
    if (controller.signal.aborted) throw new ApiError(0, "The request timed out. Please try again.")
    if (error instanceof ApiError) throw error
    throw new ApiError(0, friendlyError(0, "Network error"))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
  }
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    signal,
  )
}
function get<T>(path: string): Promise<T> {
  return requestJson<T>(path)
}

/** XHR is retained for byte progress, with bounded time and real cancellation. */
function uploadXhr(
  method: string,
  path: string,
  headers: Record<string, string>,
  bytes: Uint8Array,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const cancel = () => {
      xhr.abort()
      reject(new DOMException("Upload cancelled", "AbortError"))
    }
    if (signal?.aborted) {
      cancel()
      return
    }
    xhr.open(method, path, true)
    xhr.timeout = 120_000
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
    xhr.setRequestHeader("content-type", "application/octet-stream")
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.total || bytes.byteLength)
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr)
        : reject(new ApiError(xhr.status, friendlyError(xhr.status, "Upload failed. Try again.")))
    xhr.onerror = () => reject(new ApiError(0, friendlyError(0, "Network error")))
    xhr.ontimeout = () => reject(new ApiError(0, "Upload timed out. Please retry."))
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"))
    xhr.onloadend = () => signal?.removeEventListener("abort", cancel)
    signal?.addEventListener("abort", cancel, { once: true })
    xhr.send(bytes as unknown as XMLHttpRequestBodyInit)
  })
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
  readMessages(body: ReadReceiptRequest) {
    return post<{ ok: boolean }>("/api/messages/read", body)
  },
  consumeMessages(body: ConsumeMessagesRequest) {
    return post<{ consumedIds: string[] }>("/api/messages/consume", body)
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
  reportMessage(body: ReportMessageRequest) {
    return post<{ ok: boolean; reportId: string }>("/api/messages/report", body)
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
  signUpload(body: SignUploadRequest, signal?: AbortSignal) {
    return post<SignUploadResponse>("/api/uploads/sign", body, signal)
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
    signal?: AbortSignal,
  ): Promise<void> {
    await uploadXhr("POST", sign.uploadUrl, uploadHeaders(sign), bytes, onProgress, signal)
  },
  createMultipartUpload(
    sign: SignUploadResponse,
    signal?: AbortSignal,
  ): Promise<MultipartCreateResponse> {
    return requestJson(
      `${sign.uploadUrl}/create`,
      { method: "POST", headers: uploadHeaders(sign) },
      signal,
    )
  },
  async uploadMultipartPart(
    sign: SignUploadResponse,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<MultipartUploadedPart> {
    const xhr = await uploadXhr(
      "PUT",
      `${sign.uploadUrl}/part`,
      {
        ...uploadHeaders(sign),
        "x-vanish-upload-id": uploadId,
        "x-vanish-part": String(partNumber),
      },
      bytes,
      onProgress,
      signal,
    )
    try {
      return JSON.parse(xhr.responseText) as MultipartUploadedPart
    } catch {
      throw new ApiError(xhr.status, "Invalid multipart response")
    }
  },
  async completeMultipartUpload(
    sign: SignUploadResponse,
    uploadId: string,
    parts: MultipartUploadedPart[],
    signal?: AbortSignal,
  ): Promise<void> {
    await requestJson(
      `${sign.uploadUrl}/complete`,
      {
        method: "POST",
        headers: {
          ...uploadHeaders(sign),
          "x-vanish-upload-id": uploadId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ parts }),
      },
      signal,
    )
  },
  async abortMultipartUpload(sign: SignUploadResponse, uploadId: string): Promise<void> {
    await requestJson(`${sign.uploadUrl}/abort`, {
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
