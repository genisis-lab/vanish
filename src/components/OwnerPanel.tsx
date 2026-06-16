import { useCallback, useEffect, useMemo, useState } from "react"
import { Ban, RefreshCw, Search, ShieldCheck } from "lucide-react"
import type { OwnerQueryResponse } from "@shared/types"
import type { RoomSession } from "../lib/session"
import { Sheet, useToast } from "./ui"

type ApiErrorLike = { error?: string }

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as ApiErrorLike & T
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed")
  return data as T
}

export function OwnerPanel({
  session,
  names,
  onClose,
}: {
  session: RoomSession
  names: Record<string, string>
  onClose: () => void
}) {
  const toast = useToast()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<OwnerQueryResponse | null>(null)
  const [query, setQuery] = useState("")

  const load = useCallback(async () => {
    if (!session.ownerSecret) return
    setLoading(true)
    try {
      const result = await postJson<OwnerQueryResponse>("/api/rooms/owner-query", {
        roomId: session.invite.roomId,
        accessProof: session.keys.accessProof,
        ownerProof: session.ownerSecret,
      })
      setData(result)
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load owner tools")
    } finally {
      setLoading(false)
    }
  }, [session, toast])

  useEffect(() => {
    void load()
  }, [load])

  const runAction = useCallback(
    async (body: Record<string, unknown>, success: string) => {
      try {
        await postJson<{ ok?: boolean; room?: unknown }>("/api/rooms/owner", {
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ownerProof: session.ownerSecret,
          ...body,
        })
        toast(success)
        await load()
      } catch (e) {
        toast(e instanceof Error ? e.message : "Owner action failed")
      }
    },
    [load, session, toast],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = data?.participants ?? []
    if (!q) return list
    return list.filter((p) => {
      const name = (names[p.participantId] ?? "").toLowerCase()
      return (
        p.participantId.toLowerCase().includes(q) ||
        name.includes(q) ||
        (p.ip ?? "").toLowerCase().includes(q)
      )
    })
  }, [data, names, query])

  return (
    <Sheet title="Owner IP tools" icon={<ShieldCheck size={18} />} onClose={onClose}>
      <div style={STACK}>
        <div style={SEARCH_ROW}>
          <div style={SEARCH_WRAP}>
            <Search size={15} style={SEARCH_ICON} />
            <input
              className="input"
              style={SEARCH_INPUT}
              placeholder="Search by IP, participant ID, or name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>

        <div className="callout">
          <span>
            This panel shows operational metadata only: participant IDs, last-seen times, and the
            last recorded source IP for each participant. Messages remain end-to-end encrypted.
          </span>
        </div>

        <div style={COUNT_ROW}>
          <strong>{filtered.length}</strong>
          <span className="hint">participants matched</span>
        </div>

        <div style={LIST_WRAP}>
          {filtered.map((p) => {
            const name = names[p.participantId] || "anon"
            const isSelf = p.participantId === session.participantId
            return (
              <div key={p.participantId} style={CARD}>
                <div style={CARD_TOP}>
                  <div>
                    <div style={NAME_ROW}>
                      <strong>{name}</strong>
                      {isSelf && <span className="hint">(you)</span>}
                      {p.banned && <span style={BADGE_DANGER}>Banned</span>}
                      {p.ipBanned && <span style={BADGE_WARN}>IP banned</span>}
                    </div>
                    <div className="mono" style={PID}>{p.participantId}</div>
                  </div>
                </div>

                <div style={META_GRID}>
                  <div>
                    <div className="hint">IP</div>
                    <div className="mono">{p.ip || "—"}</div>
                  </div>
                  <div>
                    <div className="hint">Last seen</div>
                    <div>{new Date(p.lastSeen).toLocaleString()}</div>
                  </div>
                </div>

                <div style={ACTION_ROW}>
                  {!isSelf && (
                    <button
                      className={`btn ${p.banned ? "" : "btn-danger"}`}
                      onClick={() =>
                        void runAction(
                          {
                            action: p.banned ? "unban" : "ban",
                            targetParticipantId: p.participantId,
                          },
                          p.banned ? "Participant unbanned" : "Participant banned",
                        )
                      }
                    >
                      <Ban size={14} /> {p.banned ? "Unban user" : "Ban user"}
                    </button>
                  )}
                  {p.ip && (
                    <button
                      className={`btn ${p.ipBanned ? "" : "btn-danger"}`}
                      onClick={() =>
                        void runAction(
                          {
                            action: p.ipBanned ? "ip-unban" : "ip-ban",
                            targetIp: p.ip,
                          },
                          p.ipBanned ? `IP ${p.ip} unbanned` : `IP ${p.ip} banned`,
                        )
                      }
                    >
                      <Ban size={14} /> {p.ipBanned ? "Unban IP" : "Ban IP"}
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          {!loading && filtered.length === 0 && (
            <div className="hint">No participants matched your search.</div>
          )}
        </div>

        <div style={LIST_WRAP}>
          <div style={NAME_ROW}>
            <strong>IP ban list</strong>
            <span className="hint">{data?.ipBanned.length ?? 0} banned</span>
          </div>
          {(data?.ipBanned ?? []).length === 0 ? (
            <div className="hint">No IPs are currently banned.</div>
          ) : (
            (data?.ipBanned ?? []).map((ip) => (
              <div key={ip} style={BAN_ROW}>
                <span className="mono">{ip}</span>
                <button
                  className="btn"
                  onClick={() =>
                    void runAction(
                      { action: "ip-unban", targetIp: ip },
                      `IP ${ip} unbanned`,
                    )
                  }
                >
                  Unban
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </Sheet>
  )
}

const STACK = { display: "flex", flexDirection: "column", gap: "12px" } as const
const SEARCH_ROW = { display: "flex", gap: "8px", alignItems: "center" } as const
const SEARCH_WRAP = { position: "relative", flex: 1, minWidth: 0 } as const
const SEARCH_ICON = {
  position: "absolute",
  left: "10px",
  top: "50%",
  transform: "translateY(-50%)",
  opacity: 0.7,
} as const
const SEARCH_INPUT = { paddingLeft: "34px" } as const
const COUNT_ROW = { display: "flex", gap: "8px", alignItems: "baseline" } as const
const LIST_WRAP = { display: "flex", flexDirection: "column", gap: "10px" } as const
const CARD = {
  border: "1px solid var(--line)",
  borderRadius: "12px",
  padding: "12px",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  background: "var(--bg-soft)",
} as const
const CARD_TOP = { display: "flex", justifyContent: "space-between", gap: "8px" } as const
const NAME_ROW = { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } as const
const PID = { opacity: 0.8 } as const
const META_GRID = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: "10px",
} as const
const ACTION_ROW = { display: "flex", gap: "8px", flexWrap: "wrap" } as const
const BAN_ROW = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  border: "1px solid var(--line)",
  borderRadius: "10px",
  padding: "10px 12px",
  background: "var(--bg-soft)",
} as const
const BADGE_DANGER = {
  fontSize: "12px",
  padding: "2px 8px",
  borderRadius: "999px",
  background: "color-mix(in srgb, var(--danger) 16%, transparent)",
  color: "var(--danger)",
} as const
const BADGE_WARN = {
  fontSize: "12px",
  padding: "2px 8px",
  borderRadius: "999px",
  background: "color-mix(in srgb, var(--accent) 16%, transparent)",
  color: "var(--accent)",
} as const
