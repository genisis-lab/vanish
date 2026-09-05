import { useEffect, useRef, useState } from "react"
import type { DecryptedMessage } from "../lib/messages"
import type { RoomSession } from "../lib/session"
import { api } from "../lib/api"
import {
  decryptToObjectUrl,
  requiresStreamingSave,
  revokeMediaObject,
  saveLargeMediaToFile,
} from "../lib/media"
import { Sheet } from "./ui"

/** Keep the loaded view separate from the timeline: the consume response prunes
 * its message immediately, but the recipient can finish reading this view. */
export function ReadOnceViewer({
  session,
  message,
  onClose,
}: {
  session: RoomSession
  message: DecryptedMessage
  onClose: () => void
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const items = message.items ?? []
  const consume = useRef<Promise<{ consumedIds: string[] }> | null>(null)
  const alive = useRef(true)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      items.forEach((item) => revokeMediaObject(item.objectKey))
    }
  }, [message.id])

  useEffect(() => {
    let cancelled = false
    async function open() {
      setError("")
      try {
        const loaded: Record<string, string> = {}
        for (const item of items) {
          if (requiresStreamingSave(item)) continue
          const url = await decryptToObjectUrl(session, item)
          if (cancelled) {
            if (!alive.current) revokeMediaObject(item.objectKey)
            return
          }
          loaded[item.objectKey] = url
        }
        if (items.some((item) => requiresStreamingSave(item) && !saved.includes(item.objectKey)))
          return
        if (cancelled || document.visibilityState === "hidden") return
        if (message.expiresAt && message.expiresAt <= Date.now())
          throw new Error("This message expired before it could be opened.")
        consume.current ??= api
          .consumeMessages({
            roomId: session.invite.roomId,
            accessProof: session.keys.accessProof,
            participantId: session.participantId,
            participantProof: session.participantProof,
            messageIds: [message.id],
          })
          .catch((error) => {
            consume.current = null
            throw error
          })
        const receipt = await consume.current
        if (!receipt.consumedIds.includes(message.id))
          throw new Error("This message was already opened or has expired.")
        if (!cancelled) {
          setUrls(loaded)
          setReady(true)
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Could not open this message. Try again.")
      }
    }
    void open()
    return () => {
      cancelled = true
    }
  }, [session, message.id, attempt, saved])

  useEffect(() => {
    const resume = () => {
      if (!ready && document.visibilityState === "visible") setAttempt((n) => n + 1)
    }
    document.addEventListener("visibilitychange", resume)
    return () => document.removeEventListener("visibilitychange", resume)
  }, [ready])

  useEffect(() => {
    if (!ready) return
    const close = () => closeRef.current()
    const hide = () => {
      if (document.visibilityState === "hidden") close()
    }
    if (document.visibilityState === "hidden") close()
    const timer = window.setTimeout(
      close,
      Math.min(60_000, message.expiresAt ? Math.max(0, message.expiresAt - Date.now()) : 60_000),
    )
    document.addEventListener("visibilitychange", hide)
    window.addEventListener("blur", close)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", hide)
      window.removeEventListener("blur", close)
    }
  }, [ready, message.expiresAt])

  return (
    <Sheet title="Read once" onClose={onClose}>
      {ready ? (
        <div className="stack read-once-view">
          <p className="hint">
            Removed from the room. This view clears when closed, when you switch away, when its
            timer expires, or after one minute. Saved files remain on your device.
          </p>
          {message.text && <p className="read-once-text">{message.text}</p>}
          {items.map((item) =>
            saved.includes(item.objectKey) ? (
              <p key={item.objectKey}>Saved {item.filename}</p>
            ) : item.previewKind === "audio" ? (
              <audio
                key={item.objectKey}
                src={urls[item.objectKey]}
                controls
                aria-label={item.filename}
              />
            ) : item.previewKind === "video" ? (
              <video key={item.objectKey} src={urls[item.objectKey]} controls playsInline />
            ) : (
              <img key={item.objectKey} src={urls[item.objectKey]} alt={item.filename} />
            ),
          )}
          <button className="btn btn-primary" onClick={onClose}>
            Done — close view
          </button>
        </div>
      ) : (
        <div className="stack">
          <p role="status">Loading the message before removing it from the room…</p>
          {items
            .filter((item) => requiresStreamingSave(item) && !saved.includes(item.objectKey))
            .map((item) => (
              <button
                key={item.objectKey}
                className="btn"
                disabled={saving}
                onClick={async () => {
                  setSaving(true)
                  setError("")
                  try {
                    await saveLargeMediaToFile(session, item)
                    if (alive.current) setSaved((prev) => [...prev, item.objectKey])
                  } catch (e) {
                    if (alive.current)
                      setError(e instanceof Error ? e.message : "Could not save attachment")
                  } finally {
                    if (alive.current) setSaving(false)
                  }
                }}
              >
                Save large attachment: {item.filename}
              </button>
            ))}
          {error && (
            <>
              <p className="inline-error" role="alert">
                {error}
              </p>
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
                Retry opening
              </button>
            </>
          )}
          <p className="hint">
            Large attachments must finish saving before the message is consumed. Closing now leaves
            it available until its timer expires.
          </p>
        </div>
      )}
    </Sheet>
  )
}
