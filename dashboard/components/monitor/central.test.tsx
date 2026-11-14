import { render, screen } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CentralProvider } from "@/lib/central"
import { I18nProvider } from "@/lib/i18n"
import { ReplayLink } from "./replay-link"

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

describe("OpenCode Central: no way to the Replay tab the hub does not have", () => {
  it("a replay link is there on a normal monitor", async () => {
    render(<I18nProvider><CentralProvider value={false}><ReplayLink id="s1" /></CentralProvider></I18nProvider>)
    expect(await screen.findByRole("link")).toHaveAttribute("href", "#replay/s1")
  })

  it("and gone on the hub", async () => {
    const { container } = render(<I18nProvider><CentralProvider value={true}><ReplayLink id="s1" /></CentralProvider></I18nProvider>)
    await new Promise(r => setTimeout(r, 50))
    expect(container.querySelector("a")).toBeNull()
  })
})
