if (request.headers.get("Upgrade") !== "websocket") {
  return new Response("expected websocket", { status: 426 })
}

// Proofs arrive in the WebSocket subprotocol, not the query string, so they
// stay out of access logs. Format: "vanish.v1", <accessProof>,
// <participantId>, <participantProof>.
const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
  .split(",")
  .map((s) => s.trim())
const dec = (s: string | undefined) => {
  try {
    return s ? decodeURIComponent(s) : ""
  } catch {
    return s ?? ""
  }
}

const usedSubprotocol = offered[0] === "vanish.v1"
let accessProof: string
let participantId: string
let participantProof: string
if (usedSubprotocol) {
  accessProof = dec(offered[1])
  participantId = dec(offered[2]) || "anon"
  participantProof = dec(offered[3])
} else {
  // Back-compat during rollout: old clients still send query params.
  accessProof = url.searchParams.get("p") ?? ""
  participantId = url.searchParams.get("u") ?? "anon"
  participantProof = url.searchParams.get("pp") ?? ""
}
