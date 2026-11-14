import { Fragment, type ReactNode } from "react"
import { parseRich, type RichToken } from "../lib/richText"

interface Props {
  text: string
  /** Known display names, longest first (see mentionNames). */
  names: string[]
  /** This device's display name, so mentions of you stand out. */
  myName: string
  /** Called instead of navigating, so the user confirms before leaving Vanish. */
  onOpenLink: (href: string) => void
}

// Renders parsed tokens as React elements only; message text is never HTML.
export function RichText({ text, names, myName, onOpenLink }: Props) {
  const me = myName.trim().toLowerCase()
  const render = (tokens: RichToken[]): ReactNode[] =>
    tokens.map((tok, i) => {
      switch (tok.t) {
        case "text":
          return <Fragment key={i}>{tok.v}</Fragment>
        case "code":
          return (
            <code key={i} className="msg-code">
              {tok.v}
            </code>
          )
        case "bold":
          return <strong key={i}>{render(tok.children)}</strong>
        case "italic":
          return <em key={i}>{render(tok.children)}</em>
        case "mention":
          return (
            <span key={i} className={`mention ${tok.name.toLowerCase() === me ? "me" : ""}`}>
              @{tok.name}
            </span>
          )
        case "link":
          return (
            <a
              key={i}
              className="msg-link"
              href={tok.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              referrerPolicy="no-referrer"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onOpenLink(tok.href)
              }}
            >
              {tok.v}
            </a>
          )
      }
    })
  return <span>{render(parseRich(text, names))}</span>
}
