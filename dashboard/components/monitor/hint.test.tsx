import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Hint } from "./hint"

const tip = () => document.querySelector("[data-slot=tooltip-content]")
const renderHint = (node: React.ReactNode) => render(<TooltipProvider delay={0}>{node}</TooltipProvider>)
// jsdom lays nothing out: say how wide the text is, and how wide its box.
const sized = (el: HTMLElement, text: number, box: number) => {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: text })
  Object.defineProperty(el, "clientWidth", { configurable: true, value: box })
}

describe("Hint", () => {
  it("opens the page's own tooltip on hover, not the browser's", async () => {
    renderHint(<Hint label="Running version 11.0.0">v11.0.0</Hint>)
    const trigger = screen.getByText("v11.0.0")
    expect(trigger).not.toHaveAttribute("title")
    await userEvent.hover(trigger)
    await waitFor(() => expect(tip()).toHaveTextContent("Running version 11.0.0"))
  })

  it("for text cut short, opens only when it really is cut", async () => {
    renderHint(<Hint label="a-very-long-project-name" onlyWhenCut className="truncate">a-very-long-project-name</Hint>)
    const trigger = screen.getByText("a-very-long-project-name")
    sized(trigger, 100, 200)
    await userEvent.hover(trigger)
    await new Promise(r => setTimeout(r, 50))
    expect(tip()).toBeNull()

    await userEvent.unhover(trigger)
    sized(trigger, 300, 200)
    await userEvent.hover(trigger)
    await waitFor(() => expect(tip()).toHaveTextContent("a-very-long-project-name"))
  })

  it("on a button, stays one button with its own name and action", async () => {
    let clicks = 0
    renderHint(
      <Hint label="shop — Build the checkout" render={<button type="button" aria-label="shop: Working" onClick={() => clicks++} />}>
        shop
      </Hint>,
    )
    const button = screen.getByRole("button", { name: "shop: Working" })
    await userEvent.click(button)
    expect(clicks).toBe(1)
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })
})

describe("No native tooltips", () => {
  it("no component sets a title attribute on an element: every tooltip is the shadcn one", () => {
    const dir = join(__dirname)
    const offenders: string[] = []
    for (const file of readdirSync(dir).filter(f => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))) {
      const text = readFileSync(join(dir, file), "utf8")
      // A title= on a lowercase tag is the browser's tooltip; on a component it is a prop.
      for (const m of text.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?\stitle=/g)) offenders.push(`${file}: <${m[1]}>`)
    }
    expect(offenders).toEqual([])
  })
})
