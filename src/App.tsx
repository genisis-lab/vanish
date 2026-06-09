import { useCallback, useEffect, useState } from "react"
import { parseInviteFromUrl, parseInviteKey, type ParsedInvite } from "@shared/invite"
import { ToastProvider } from "./components/ui"
import { Home } from "./components/Home"
import { InviteJoin } from "./components/InviteJoin"
import { ChatRoom } from "./components/ChatRoom"
import { VaultLock } from "./components/VaultLock"
import { usePrefs } from "./lib/usePrefs"
import { buildSession, type RoomSession } from "./lib/session"
import { vault } from "./lib/vault"
import { setActiveRoom } from "./lib/activeRoom"

type Route =
  | { name: "home" }
  | { name: "join"; invite: ParsedInvite }
  | { name: "chat"; session: RoomSession }

export default function App() {
  const prefs = usePrefs()
  const [route, setRoute] = useState<Route>({ name: "home" })
  const [locked, setLocked] = useState(() => vault.isLocked())

  // Remove the invite secret from the address bar (both fragment and any legacy
  // query param) so it can't leak via history, Referer headers, or screen shares.
  const scrubInviteFromUrl = useCallback(() => {
    const url = new URL(window.location.href)
    let changed = false
    if (url.searchParams.has("invite")) {
      url.searchParams.delete("invite")
      changed = true
    }
    if (url.hash) {
      url.hash = ""
      changed = true
    }
    if (changed) window.history.replaceState({}, "", url.pathname + url.search)
  }, [])

  // On first load, honor an invite link, then immediately scrub the secret.
  useEffect(() => {
    const invite = parseInviteFromUrl(window.location.href)
    if (invite) {
      setRoute({ name: "join", invite })
      scrubInviteFromUrl()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tell the service worker which room (if any) is on screen. The current push
  // policy suppresses system notifications whenever any Vanish window is visible
  // in the foreground, and still alerts when the app is hidden or closed.
  useEffect(() => {
    setActiveRoom(route.name === "chat" ? route.session.invite.roomId : null)
  }, [route])

  const goHome = useCallback(() => {
    scrubInviteFromUrl()
    setRoute({ name: "home" })
  }, [scrubInviteFromUrl])

  const enterChat = useCallback((session: RoomSession) => {
    setRoute({ name: "chat", session })
  }, [])

  const goJoinByKey = useCallback((rawKey: string): boolean => {
    const trimmed = rawKey.trim()
    // Accept either a raw invite key (anonchat:v1:…) or a full invite link
    // (https://…/#invite=…) pasted into the join box.
    const invite = parseInviteKey(trimmed) ?? parseInviteFromUrl(trimmed)
    if (invite) setRoute({ name: "join", invite })
    return !!invite
  }, [])

  // Resume a remembered room directly into chat.
  const resume = useCallback(
    async (roomId: string) => {
      const r = vault.get(roomId)
      if (!r) return
      const invite = parseInviteKey(r.inviteKey)
      if (!invite) return
      const session = await buildSession(invite, r.username, r.participantId)
      enterChat(session)
    },
    [enterChat],
  )

  let screen = null
  if (locked) {
    screen = <VaultLock onDone={() => setLocked(false)} />
  } else if (route.name === "home") {
    screen = <Home prefs={prefs} onCreated={enterChat} onJoinKey={goJoinByKey} onResume={resume} />
  } else if (route.name === "join") {
    screen = (
      <InviteJoin invite={route.invite} prefs={prefs} onJoined={enterChat} onCancel={goHome} />
    )
  } else {
    screen = <ChatRoom session={route.session} prefs={prefs} onLeave={goHome} />
  }

  return (
    <ToastProvider>
      <div className="app">{screen}</div>
    </ToastProvider>
  )
}
