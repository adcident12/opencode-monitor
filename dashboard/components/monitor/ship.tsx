"use client"

import { useEffect, useRef, useState } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { bubbleOf, COLUMNS, crewOf, dronesOf, fuelOf, layout, lookOf, NARROW_BELOW, NARROW_COLUMNS, screenOf, STATION_H, STATION_W, tagOf } from "@/lib/ship"
import { drawShip } from "@/lib/ship-draw"
import type { Session, Snapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import { AttentionCard, QuietRow, WorkingCard } from "./sessions"
import { Hint } from "./hint"

const FRAME_MS = 125 // eight pictures a second is enough for pixel art, and cheap
/** Marks a compaction the drawing loop has not shown yet. */
const JUST = -1
const NEEDS_YOU = new Set(["waiting", "stuck", "error"])

/**
 * The Now tab as a ship's bridge: one crew member per session, most urgent first. Only a
 * picture of what the cards say; the card of the station you pick is shown under it.
 */
export function Ship({ snapshot, now, history }: Readonly<{ snapshot: Snapshot; now: number; history: boolean }>) {
  const { t } = useI18n()
  const sessions = snapshot.sessions
  const { crew, more } = crewOf(sessions)
  const columns = useColumns()
  const { stations, width, height } = layout(crew.length, columns)
  const [picked, setPicked] = useState<string | null>(null)
  const selected = crew.find(s => s.id === picked) ?? crew[0] ?? null

  // What to draw, worked out from the snapshot; the drawing loop reads the latest of it.
  const data = {
    width,
    height,
    mcp: (snapshot.environment?.mcp ?? []).filter(m => m.status !== "disabled").map(m => m.status as "ok" | "failed" | "unknown"),
    stations: crew.map((s, i) => ({
      ...stations[i],
      id: s.id,
      compactions: s.health.compactions,
      screen: screenOf(s),
      state: s.state,
      look: lookOf(s.id),
      fuel: fuelOf(s),
      drones: dronesOf(sessions, s.id).shown.length,
      selected: s.id === selected?.id,
    })),
  }
  const scene = useRef(data)
  // When each session's compaction count last went up, so its gauge puffs once.
  const compacted = useRef(new Map<string, { count: number; at: number | null }>())
  useEffect(() => {
    scene.current = data
    for (const st of data.stations) {
      const seen = compacted.current.get(st.id)
      if (!seen) compacted.current.set(st.id, { count: st.compactions, at: null })
      else if (st.compactions > seen.count) compacted.current.set(st.id, { count: st.compactions, at: JUST })
    }
  })

  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const g = canvas.current?.getContext("2d")
    if (!g) return
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0
    let last = 0
    let id = 0
    const paint = (time: number) => {
      id = requestAnimationFrame(paint)
      if (time - last < FRAME_MS) return
      last = time
      if (!calm.matches) frame++
      const { width: w, height: h, mcp, stations: list } = scene.current
      // A compaction seen since the last picture starts its puff now.
      for (const seen of compacted.current.values()) if (seen.at === JUST) seen.at = time
      drawShip(g, { width: w, height: h, mcp, frame, now: time, still: calm.matches, stations: list.map(st => ({ ...st, compactedAt: compacted.current.get(st.id)?.at ?? null })) })
    }
    id = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(id)
  }, [])

  if (!crew.length) return null
  const pct = (n: number, of: number) => `${(n / of) * 100}%`

  return (
    <div className="space-y-4">
      {/* Whole pixels on a wide screen; a fraction only where the screen is narrower than the ship. */}
      {/* The canvas has no content of its own to announce; the list of stations over it says it in words. */}
      <div className="overflow-hidden rounded-xl border-4 border-[#2c3557] bg-[#070a18] shadow-[0_0_0_1px_var(--color-border)]">
        <div className="relative">
          <canvas
            ref={canvas}
            width={width}
            height={height}
            className="block h-auto w-full [image-rendering:pixelated]"
          />
          <ul className="absolute inset-0" aria-label={t("ship.label", { n: crew.length })}>
            {crew.map((s, i) => (
              <li key={s.id} className="absolute" style={{ left: pct(stations[i].x + 8, width), top: pct(stations[i].y, height), width: pct(STATION_W - 16, width), height: pct(STATION_H - 6, height) }}>
                <StationButton session={s} tag={tagOf(s, crew)} now={now} selected={s.id === selected?.id} onPick={() => setPicked(s.id)} drones={dronesOf(sessions, s.id).more} />
              </li>
            ))}
          </ul>
        </div>
      </div>

      {more > 0 && <p className="text-sm text-muted-foreground">{t("ship.more", { n: more })}</p>}
      <Legend />

      {selected && (
        <section aria-label={t("ship.picked")} className="space-y-3">
          <PickedCard session={selected} subagents={sessions.filter(s => s.parentId === selected.id)} now={now} history={history} />
        </section>
      )}
    </div>
  )
}

/** The same card the Cards view would show for this session. */
function PickedCard({ session, subagents, now, history }: Readonly<{ session: Session; subagents: Session[]; now: number; history: boolean }>) {
  if (NEEDS_YOU.has(session.state)) return <AttentionCard session={session} subagents={subagents} now={now} history={history} />
  if (session.state === "working") return <WorkingCard session={session} subagents={subagents} now={now} history={history} />
  return (
    <ul className="rounded-xl border bg-card">
      <QuietRow session={session} now={now} history={history} />
    </ul>
  )
}

/** Two columns on a narrow screen, three otherwise; follows the window as it is resized. */
function useColumns() {
  const [columns, setColumns] = useState(COLUMNS)
  useEffect(() => {
    const narrow = window.matchMedia(`(max-width: ${NARROW_BELOW - 1}px)`)
    const apply = () => setColumns(narrow.matches ? NARROW_COLUMNS : COLUMNS)
    apply()
    narrow.addEventListener("change", apply)
    return () => narrow.removeEventListener("change", apply)
  }, [])
  return columns
}

/**
 * The hit area of a station. Its name tag and bubble are text, not pixels, so they stay
 * sharp, translate, and never run into the next station: the tag is cut short with an
 * ellipsis, and the full name is in the label and the card.
 */
function StationButton({ session, tag, now, selected, onPick, drones }: Readonly<{ session: Session; tag: string; now: number; selected: boolean; onPick: () => void; drones: number }>) {
  const { t } = useI18n()
  const bubble = bubbleOf(session, now, t, ms => rough(ms))
  const name = session.project || session.title || session.id
  return (
    <Hint
      label={<StationTip name={name} title={session.title || session.id} state={t(`state.${session.state}`)} />}
      render={<button type="button" onClick={onPick} aria-pressed={selected} aria-label={t("ship.station", { project: name, state: t(`state.${session.state}`), title: session.title || session.id })} />}
      className="group relative block size-full rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      {/* Inside the station, over its beacon: never up into the row above. */}
      {bubble && (
        <span
          className={cn(
            "absolute top-0 left-1/2 max-w-full -translate-x-1/2 truncate px-1.5 py-px text-[clamp(0.625rem,1.4vw,0.75rem)] leading-snug font-medium text-[#0d1022]",
            "shadow-[0_-2px_0_#0d1022,0_2px_0_#0d1022,-2px_0_0_#0d1022,2px_0_0_#0d1022]",
            BUBBLE[session.state],
            (session.state === "waiting" || session.state === "error") && "motion-safe:animate-[ship-hop_1s_step-end_infinite]",
          )}
        >
          {bubble}
        </span>
      )}
      <span
        className={cn(
          "absolute bottom-0 left-1/2 max-w-[calc(100%-4px)] -translate-x-1/2 truncate px-1.5 font-mono text-[clamp(0.5625rem,1.2vw,0.6875rem)] leading-relaxed",
          selected ? "bg-[#e9edff] text-[#0d1022]" : "bg-[#0d1022] text-[#e9edff] group-hover:bg-[#2c3557]",
        )}
      >
        {tag}
      </span>
      {drones > 0 && <span className="absolute top-[30%] right-0 font-mono text-2xs text-[#9be7c4]">+{drones}</span>}
    </Hint>
  )
}

/** Which session a station is: its folder, its title and its state, each in full. */
function StationTip({ name, title, state }: Readonly<{ name: string; title: string; state: string }>) {
  return (
    <span className="grid gap-0.5">
      <span className="font-mono">{name}</span>
      <span className="font-medium">{title}</span>
      <span className="text-background/70">{state}</span>
    </span>
  )
}

const BUBBLE: Record<string, string> = {
  waiting: "bg-[#ffc04d]",
  stuck: "bg-[#ff9f68]",
  error: "bg-[#ff7a8a]",
  finished: "bg-[#9be7c4]",
}

/** What each thing on the bridge means: the picture is a shortcut, never the only way to read it. */
function Legend() {
  const { t } = useI18n()
  const rows = ["waiting", "stuck", "error", "working", "finished", "idle", "fuel", "drone", "lights"] as const
  return (
    <Collapsible>
      <CollapsibleTrigger className="rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        {t("ship.legend.title")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(key => (
            <div key={key} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3">
              <dt className="font-medium">{t(`ship.legend.${key}`)}</dt>
              <dd className="text-muted-foreground">{t(`ship.legend.${key}.means`)}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}
