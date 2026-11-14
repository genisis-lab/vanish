import { describe, expect, it } from "vitest"
import {
  mentionNames,
  mentionsName,
  parseRich,
  plainText,
  safeHref,
} from "../../src/lib/richText"

describe("rich text parsing", () => {
  it("leaves plain text alone", () => {
    expect(parseRich("just words 2*3 snake_case_name")).toEqual([
      { t: "text", v: "just words 2*3 snake_case_name" },
    ])
  })

  it("finds http(s) and www links and trims trailing punctuation", () => {
    expect(parseRich("see https://example.com/a?b=1. ok")).toEqual([
      { t: "text", v: "see " },
      { t: "link", v: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { t: "text", v: ". ok" },
    ])
    expect(parseRich("(www.example.com)")[1]).toEqual({
      t: "link",
      v: "www.example.com",
      href: "https://www.example.com/",
    })
    expect(parseRich("wiki https://en.wikipedia.org/wiki/Foo_(bar)")[1]).toMatchObject({
      v: "https://en.wikipedia.org/wiki/Foo_(bar)",
    })
  })

  it("never links non-http schemes", () => {
    expect(parseRich("javascript:alert(1) data:text/html,x")).toEqual([
      { t: "text", v: "javascript:alert(1) data:text/html,x" },
    ])
    expect(safeHref("javascript:alert(1)")).toBeNull()
  })

  it("formats bold, italic and code", () => {
    expect(parseRich("**big** and *soft* and _also_ and `x*y*z`")).toEqual([
      { t: "bold", children: [{ t: "text", v: "big" }] },
      { t: "text", v: " and " },
      { t: "italic", children: [{ t: "text", v: "soft" }] },
      { t: "text", v: " and " },
      { t: "italic", children: [{ t: "text", v: "also" }] },
      { t: "text", v: " and " },
      { t: "code", v: "x*y*z" },
    ])
  })

  it("matches the longest known name for mentions, not emails", () => {
    const names = mentionNames(["Sam", "Sam Lee", "anon"])
    expect(parseRich("hi @sam lee!", names)).toEqual([
      { t: "text", v: "hi " },
      { t: "mention", name: "sam lee" },
      { t: "text", v: "!" },
    ])
    expect(parseRich("mail sam@example.com", names)).toEqual([
      { t: "text", v: "mail sam@example.com" },
    ])
    expect(parseRich("@Samuel", names)).toEqual([{ t: "text", v: "@Samuel" }])
  })

  it("strips formatting for previews", () => {
    expect(plainText("**big** _news_ at `noon` https://a.example")).toBe(
      "big news at noon https://a.example",
    )
  })

  it("detects a mention of a given name", () => {
    expect(mentionsName("hey **@Ash** look", "ash")).toBe(true)
    expect(mentionsName("hey @Ashley", "Ash")).toBe(false)
    expect(mentionsName("hey @anon", "anon")).toBe(false)
  })
})
