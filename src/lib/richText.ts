// Lightweight, safe message formatting: links, @mentions, **bold**, *italic* /
// _italic_ and `code`. Parsing produces plain tokens that are rendered as React
// elements, so message text is never injected as HTML.
//
// Links are only made clickable here. Nothing fetches them (no previews, no
// server or worker lookups), so no one's IP reaches a linked site unless that
// person chooses to open the link themselves.

export type RichToken =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; v: string; href: string }
  | { t: "mention"; name: string }
  | { t: "bold"; children: RichToken[] }
  | { t: "italic"; children: RichToken[] }

interface Match {
  index: number
  end: number
  token: (names: string[], depth: number) => RichToken
}

const WORD = /[\p{L}\p{N}_]/u
const isWordChar = (ch: string | undefined) => !!ch && WORD.test(ch)

function findCode(text: string, from: number): Match | null {
  const re = /`([^`\n]+)`/g
  re.lastIndex = from
  const m = re.exec(text)
  if (!m) return null
  return { index: m.index, end: m.index + m[0].length, token: () => ({ t: "code", v: m[1] }) }
}

const TRAILING = /[.,!?;:'"*_\]}>]$/

/** Only http(s) links are linkable; anything else stays plain text. */
export function safeHref(raw: string): string | null {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw
  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return url.href
  } catch {
    return null
  }
}

function findLink(text: string, from: number): Match | null {
  const re = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi
  re.lastIndex = from
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (isWordChar(text[m.index - 1])) continue
    let v = m[0]
    // Drop trailing punctuation, and a closing paren unless the link opened one.
    for (;;) {
      if (TRAILING.test(v)) v = v.slice(0, -1)
      else if (v.endsWith(")") && (v.match(/\(/g)?.length ?? 0) < (v.match(/\)/g)?.length ?? 0))
        v = v.slice(0, -1)
      else break
    }
    const href = safeHref(v)
    if (!href || /^(?:https?:\/\/|www\.)$/i.test(v)) continue
    const index = m.index
    return { index, end: index + v.length, token: () => ({ t: "link", v, href }) }
  }
  return null
}

function findWrapped(
  text: string,
  from: number,
  marker: string,
  kind: "bold" | "italic",
): Match | null {
  let i = text.indexOf(marker, from)
  while (i !== -1) {
    const before = text[i - 1]
    const start = i + marker.length
    const okBefore = !isWordChar(before) && before !== marker[0]
    if (okBefore && text[start] && !/\s/.test(text[start]) && text[start] !== marker[0]) {
      let j = text.indexOf(marker, start)
      while (j !== -1) {
        const inner = text.slice(start, j)
        if (inner.includes("\n")) break
        const after = text[j + marker.length]
        if (!/\s/.test(text[j - 1]) && !isWordChar(after) && after !== marker[0]) {
          return {
            index: i,
            end: j + marker.length,
            token: (names, depth) => ({ t: kind, children: parseRich(inner, names, depth + 1) }),
          }
        }
        j = text.indexOf(marker, j + 1)
      }
    }
    i = text.indexOf(marker, i + 1)
  }
  return null
}

function findMention(text: string, from: number, names: string[]): Match | null {
  if (names.length === 0) return null
  const lower = text.toLowerCase()
  let i = text.indexOf("@", from)
  while (i !== -1) {
    if (!isWordChar(text[i - 1])) {
      for (const name of names) {
        const end = i + 1 + name.length
        if (lower.startsWith(name.toLowerCase(), i + 1) && !isWordChar(text[end])) {
          return { index: i, end, token: () => ({ t: "mention", name: text.slice(i + 1, end) }) }
        }
      }
    }
    i = text.indexOf("@", i + 1)
  }
  return null
}

/** Sorts candidate mention names longest first so "Sam Lee" wins over "Sam". */
export function mentionNames(names: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    const key = name.toLowerCase()
    if (!name || key === "anon" || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out.sort((a, b) => b.length - a.length)
}

export function parseRich(text: string, names: string[] = [], depth = 0): RichToken[] {
  const out: RichToken[] = []
  let pos = 0
  const pushText = (v: string) => {
    if (!v) return
    const last = out[out.length - 1]
    if (last?.t === "text") last.v += v
    else out.push({ t: "text", v })
  }
  while (pos < text.length) {
    const candidates = [
      findCode(text, pos),
      findLink(text, pos),
      depth < 3 ? findWrapped(text, pos, "**", "bold") : null,
      depth < 3 ? findWrapped(text, pos, "*", "italic") : null,
      depth < 3 ? findWrapped(text, pos, "_", "italic") : null,
      findMention(text, pos, names),
    ]
    let best: Match | null = null
    for (const c of candidates) if (c && (!best || c.index < best.index)) best = c
    if (!best) break
    pushText(text.slice(pos, best.index))
    out.push(best.token(names, depth))
    pos = best.end
  }
  pushText(text.slice(pos))
  return out
}

/** True when `text` @mentions `name` (case-insensitive, whole name only). */
export function mentionsName(text: string | undefined, name: string): boolean {
  if (!text || !name.trim() || name.trim().toLowerCase() === "anon") return false
  const target = name.trim().toLowerCase()
  const walk = (tokens: RichToken[]): boolean =>
    tokens.some((tok) =>
      tok.t === "mention"
        ? tok.name.toLowerCase() === target
        : tok.t === "bold" || tok.t === "italic"
          ? walk(tok.children)
          : false,
    )
  return walk(parseRich(text, [name.trim()]))
}

/** The text with formatting markers removed, for one-line previews. */
export function plainText(text: string): string {
  const flat = (tokens: RichToken[]): string =>
    tokens
      .map((tok) =>
        tok.t === "bold" || tok.t === "italic"
          ? flat(tok.children)
          : tok.t === "mention"
            ? `@${tok.name}`
            : tok.v,
      )
      .join("")
  return flat(parseRich(text))
}
