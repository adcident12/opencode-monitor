import { describe, expect, it } from "vitest"
import { cell, dailyCsv, sessionsCsv, toCsv } from "./csv"

describe("csv", () => {
  it("quotes only what needs quoting", () => {
    expect(cell("plain")).toBe("plain")
    expect(cell('say "hi", then go')).toBe('"say ""hi"", then go"')
    expect(cell("two\nlines")).toBe('"two\nlines"')
    expect(cell(12.5)).toBe("12.5")
    expect(cell(null)).toBe("")
  })

  it("never lets a title become a spreadsheet formula", () => {
    expect(cell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"")
    expect(cell("+1")).toBe("'+1")
    expect(cell("@sum")).toBe("'@sum")
    // Numbers stay numbers, negative ones included.
    expect(cell(-3)).toBe("-3")
  })

  it("starts with a byte-order mark, so Thai opens correctly in a spreadsheet", () => {
    const text = toCsv(["title"], [["ระบบคิว"]])
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.slice(1)).toBe("title\r\nระบบคิว\r\n")
  })

  it("writes days and sessions in minutes", () => {
    const day = { date: "2026-10-10", activeMs: 90_000, waitMs: 30_000, prompts: 2, stuck: 0, abandoned: 0, toolCalls: 40, toolErrors: 1, compactions: 1, sessions: 1, tokens: 900, cost: 0.35 }
    expect(dailyCsv([day]).split("\r\n")[1]).toBe("2026-10-10,1.5,0.5,2,0,0,40,1,1,1,900,0.35")
    const row = { id: "ses_1", title: "Fix, then ship", project: "shop", activeMs: 3_600_000, waitMs: 0, compactions: 2, tokens: 5, cost: 1.2, toolCalls: 3, lastAt: Date.UTC(2026, 9, 10) }
    expect(sessionsCsv([row]).split("\r\n")[1]).toBe('ses_1,"Fix, then ship",shop,60,0,2,5,1.2,3,2026-10-10T00:00:00.000Z')
  })
})
