import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { I18nProvider } from "@/lib/i18n"
import manifest from "@/app/manifest"
import { InstallButton } from "./install"

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

const renderButton = () =>
  render(
    <I18nProvider>
      <TooltipProvider>
        <InstallButton />
      </TooltipProvider>
    </I18nProvider>,
  )

/** What Chrome sends when the page can be installed. */
function offer() {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: vi.fn(async () => ({ outcome: "accepted" })) })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

describe("Installing the monitor as an app", () => {
  it("offers nothing until the browser says it can be installed", () => {
    renderButton()
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
  })

  it("installs through the browser's own prompt, once, in place of its banner", async () => {
    renderButton()
    const event = offer()
    expect(event.defaultPrevented).toBe(true)
    await userEvent.click(screen.getByRole("button", { name: "Install app" }))
    expect(event.prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
  })

  it("goes away once the app is installed", () => {
    renderButton()
    offer()
    act(() => {
      window.dispatchEvent(new Event("appinstalled"))
    })
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
  })

  it("has a manifest a browser accepts, with icons that are in the page's files", () => {
    const m = manifest()
    expect(m).toMatchObject({ name: "OpenCode Monitor", start_url: "/", scope: "/", display: "standalone" })
    expect(m.icons?.map(i => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]))
    for (const icon of m.icons ?? []) {
      const png = readFileSync(join(__dirname, "..", "..", "public", icon.src))
      // A PNG of the size it says: width and height are in its header.
      expect(png.subarray(1, 4).toString()).toBe("PNG")
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes)
    }
  })
})
