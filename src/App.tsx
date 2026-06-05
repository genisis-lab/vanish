import { useCallback, useEffect, useState } from "react"
import { parseInviteFromUrl, parseInviteKey, type ParsedInvite } from "@shared/invite"
import { ToastProvider } from "./components/ui"
import { Home } from "./components/Home"
import { InviteJoin } from "./components/InviteJoin"
import { ChatRoom } from "./components/ChatRoom"
import { usePrefs } from "./lib/usePrefs"
import { buildSession, type RoomSession } from "./lib/session"
import { vault } from "./lib/vault"

type Route =
  | { name: "home" }
  | { name: "join"; invite: ParsedInvite }
  | { name: "chat"; session: RoomSession }

export default function App() {
  const prefs = usePrefs()
  const [route, setRoute] = useState<Route>({ name: "home" })

  // On first load, honor an ?invite= link.
  useEffect(() => {
    const invite = parseInviteFromUrl(window.location.href)
    if (invite) setRoute({ name: "join", invite })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearInviteParam = useCallback(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has("invite")) {
      url.searchParams.delete("invite")
      window.history.replaceState({}, "", url.pathname + url.search)
    }
  }, [])

  const goHome = useCallback(() => {
    clearInviteParam()
    setRoute({ name: "home" })
  }, [clearInviteParam])

  const enterChat = useCallback((session: RoomSession) => {
    setRoute({ name: "chat", session })
  }, [])

  const goJoinByKey = useCallback((rawKey: string): boolean => {
    const invite = parseInviteKey(rawKey.trim())
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
  if (route.name === "home") {
    screen = (
      <Home prefs={prefs} onCreated={enterChat} onJoinKey={goJoinByKey} onResume={resume} />
    )
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
