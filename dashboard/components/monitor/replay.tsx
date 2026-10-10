"use client"

import { ChartColumnIcon, HistoryIcon, RocketIcon, UserIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { duration, kilo } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useReplay, useReplaySessions } from "@/lib/live"
import { eventsOf, figuresAt, screenAt, segAt, stateAt, type Replay as ReplayData, type ReplayEvent, type ReplayState, type Seg } from "@/lib/replay"
import { drawScene, toolInUse, toolsOf, type SceneInput } from "@/lib/replay-scene"
import { layout, lookOf } from "@/lib/ship"
import { drawShip } from "@/lib/ship-draw"
import { cn } from "@/lib/utils"
import { Hint } from "./hint"
import { BridgeReplay } from "./replay-bridge"
import { BUBBLE, BUBBLE_BG, doingAt, Loading, ReplayBadge, Timeline, Transport, useAt, useFrame, usePlayer, type Clock } from "./replay-player"
import { Facts, H3, SUB, TAB } from "./section"
import { SessionFilter } from "./session-filter"
import { StateBadge } from "./state"

/** The tools given a place of their own in the picture; the rest share one. */
const TOOLS_SHOWN = 6
/** How long the dot takes from the agent to a tool, and how long a line stays after its call, in ms on screen. */
const TRAVEL_MS = 1500
const GLOW_MS = 700
/** The events kept in view; the list keeps room for this many, so it never grows while playing. */
const EVENTS_SHOWN = 7
/** Pixels of sky cut off the top of the one station. */
const SKY_CUT = 30
/**
 * One session played back: the bridge, the panel of that moment, the agent and its tools,
 * and a timeline, all at the same playhead. Labelled as a replay everywhere, so a raised
 * hand here is never taken for someone waiting now.
 */
export function Replay({ session, onSession }: Readonly<{ session: string | null; onSession: (id: string | null) => void }>) {
  // The whole bridge is remembered against the session it was turned on over: following a
  // link to another session's replay shows that session, not the bridge.
  const [bridgeOver, setBridgeOver] = useState<string | false>(false)
  const whole = bridgeOver !== false && bridgeOver === (session ?? "")
  const open = (id: string) => {
    setBridgeOver(false)
    onSession(id)
  }
  return (
    <div className={TAB}>
      <ModeSwitch whole={whole} onChange={on => setBridgeOver(on ? (session ?? "") : false)} />
      {whole ? <BridgeReplay onOpen={open} /> : <OneSession session={session} onSession={onSession} />}
    </div>
  )
}

/** One session played back, or every session of a day at once. */
function ModeSwitch({ whole, onChange }: Readonly<{ whole: boolean; onChange: (whole: boolean) => void }>) {
  const { t } = useI18n()
  const options = [
    { value: false, label: t("replay.mode.session"), Icon: UserIcon },
    { value: true, label: t("replay.mode.bridge"), Icon: RocketIcon },
  ]
  return (
    <fieldset className="inline-flex self-start rounded-lg border bg-card p-0.5">
      <legend className="sr-only">{t("replay.mode")}</legend>
      {options.map(({ value, label, Icon }) => (
        <button
          key={label}
          type="button"
          aria-pressed={whole === value}
          onClick={() => onChange(value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            whole === value ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon aria-hidden className="size-4" />
          {label}
        </button>
      ))}
    </fieldset>
  )
}

function OneSession({ session, onSession }: Readonly<{ session: string | null; onSession: (id: string | null) => void }>) {
  const { t } = useI18n()
  const sessions = useReplaySessions(true)
  const id = session ?? sessions?.[0]?.id ?? null
  const { replay, failed } = useReplay(id)

  return (
    <>
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          {sessions && sessions.length > 0 && <SessionFilter value={id} onChange={next => next && onSession(next)} sessions={sessions} current={replay?.session} allowAll={false} />}
          {id && <CrossLinks id={id} />}
        </div>
        <p className="max-w-prose text-xs text-muted-foreground">{t("replay.source")}</p>
      </div>
      {sessions && !sessions.length && <p className="text-sm text-muted-foreground">{t("replay.none")}</p>}
      {failed && !replay && <p className="text-sm text-error">{t("replay.failed")}</p>}
      {id && !replay && !failed && <Loading />}
      {replay && <Player key={replay.session.id} replay={replay} />}
    </>
  )
}

/** The same session in the other tabs. */
function CrossLinks({ id }: Readonly<{ id: string }>) {
  const { t } = useI18n()
  const link = "inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <nav aria-label={t("replay.elsewhere")} className="flex items-center gap-4 sm:ml-auto">
      <a href={`#stats/${id}`} className={link}>
        <ChartColumnIcon aria-hidden className="size-3.5" />
        {t("links.stats")}
      </a>
      <a href={`#history/${id}`} className={link}>
        <HistoryIcon aria-hidden className="size-3.5" />
        {t("links.history")}
      </a>
    </nav>
  )
}

function Player({ replay }: Readonly<{ replay: ReplayData }>) {
  const player = usePlayer(replay)
  const { clock, play, now, goTo } = player
  const at = useAt()
  const frame = useFrame()
  const { state, seg } = stateAt(replay, now)
  const figures = figuresAt(replay, now)
  const events = useMemo(() => eventsOf(replay), [replay])

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-2xl font-semibold break-words">{replay.session.title || replay.session.id}</h2>
          <p className="font-mono text-code text-muted-foreground [overflow-wrap:anywhere]">{replay.session.project}</p>
        </div>
        <ReplayBadge />
      </div>

      <Transport player={player} moments={events} at={at} />

      {/* Two columns of about the same height on a wide screen; on a phone, the picture and then what it means. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start">
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-1">
            <Station replay={replay} now={now} play={play} state={state} seg={seg} busy={figures.busy.length} frame={frame} clock={clock} />
          </div>
          <div className="order-3">
            <Scene replay={replay} now={now} state={state} seg={seg} />
          </div>
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-2">
            <Moment replay={replay} now={now} state={state} seg={seg} figures={figures} />
          </div>
          <div className="order-4">
            <Story replay={replay} events={events} now={now} figures={figures} at={at} onSeek={goTo} />
          </div>
        </div>
      </div>

      <Timeline rows={replay.rows} compactions={replay.compactions} clock={clock} play={play} onSeek={player.setPlay} at={at} />
    </>
  )
}

/** The session's station on the bridge, at that moment: the same drawing as the live Ship. */
function Station({ replay, now, play, state, seg, busy, frame, clock }: Readonly<{ replay: ReplayData; now: number; play: number; state: ReplayState; seg: Seg | null; busy: number; frame: number; clock: Clock }>) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const { stations, width, height } = layout(1, 1)
  const context = figuresAt(replay, now).context
  const limit = replay.contextLimit
  const lastCompaction = replay.compactions.findLast(c => c <= now) ?? null
  useEffect(() => {
    const g = canvas.current?.getContext("2d")
    if (!g) return
    drawShip(g, {
      width, height, mcp: [], frame, now: play, still: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      stations: [{
        ...stations[0],
        screen: screenAt(state, seg),
        state,
        look: lookOf(replay.session.id),
        fuel: { fill: context != null && limit ? Math.min(1, context / limit) : null, tick: replay.compactAt && limit ? replay.compactAt / limit : null, high: context != null && replay.compactAt != null && context >= replay.compactAt * 0.85 },
        drones: busy,
        selected: false,
        // The puff is timed in playback, so it shows at any speed.
        compactedAt: lastCompaction == null ? null : clock.toPlay(lastCompaction),
      }],
    })
  })
  const bubble = BUBBLE[state]
  return (
    <div className="relative overflow-hidden rounded-xl border-4 border-[#2c3557] bg-[#070a18]">
      {/* Only the bottom of the window shows: one station needs less sky than a whole bridge. */}
      <canvas ref={canvas} width={width} height={height} className="block h-auto w-full [image-rendering:pixelated]" style={{ marginTop: `-${(SKY_CUT / width) * 100}%` }} />
      <span className="absolute top-2 left-2 bg-[#0d1022] px-1.5 font-mono text-2xs tracking-wider text-[#e9edff]">REPLAY</span>
      {bubble && (
        <span className={cn("absolute top-[24%] left-1/2 -translate-x-1/2 px-2 py-px text-sm font-medium whitespace-nowrap text-[#0d1022] shadow-[0_-2px_0_#0d1022,0_2px_0_#0d1022,-2px_0_0_#0d1022,2px_0_0_#0d1022]", BUBBLE_BG[state])}>
          {t(bubble, { t: seg ? duration(now - seg[0]) : "" })}
        </span>
      )}
    </div>
  )
}

/** What the session was doing at that moment, and its figures: the card of the Now tab, then. */
function Moment({ replay, now, state, seg, figures }: Readonly<{ replay: ReplayData; now: number; state: ReplayState; seg: Seg | null; figures: ReturnType<typeof figuresAt> }>) {
  const { t } = useI18n()
  const limit = replay.contextLimit
  const point = replay.compactAt
  const ctx = figures.context
  let contextText = "–"
  if (figures.compacting) contextText = t("replay.kind.compact")
  else if (ctx != null) contextText = limit ? `${kilo(ctx)} / ${kilo(limit)}` : kilo(ctx)
  const doing = doingAt(t, state, seg, figures.busy[0] ?? null, now)

  return (
    <section aria-label={t("replay.moment")} className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex h-6 items-center gap-x-3 overflow-hidden whitespace-nowrap">
        <StateBadge state={state} label={t(`state.${state}`)} />
        {seg && <span className="truncate text-sm text-muted-foreground tabular-nums">{t("replay.for", { t: duration(now - seg[0]) })}</span>}
      </div>
      {/* Three lines, always: a letter from another alphabet makes a line taller, and must not make the panel taller. */}
      <Hint label={doing} onlyWhenCut render={<p />} className="line-clamp-3 h-18 text-base leading-6 break-words">
        {doing}
      </Hint>
      <Facts
        className="grid-cols-3"
        items={[
          { key: "elapsed", label: t("replay.elapsed"), value: duration(now - replay.start) },
          { key: "tools", label: t("replay.toolCalls"), value: figures.toolCalls },
          { key: "waited", label: t("replay.waited"), value: duration(figures.waitedMs) },
        ]}
      />
      <div className="space-y-1.5">
        <div className="flex h-4 items-center justify-between gap-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          <span>{t("health.context")}</span>
          <span>{contextText}</span>
        </div>
        <div className="relative h-2.5 rounded-full bg-muted">
          {ctx != null && limit != null && <span className={cn("absolute inset-y-0 left-0 rounded-full", point != null && ctx >= point * 0.85 ? "bg-waiting" : "bg-working")} style={{ width: `${Math.min(100, (ctx / limit) * 100)}%` }} />}
          {point != null && limit != null && <span aria-hidden className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground" style={{ left: `${(point / limit) * 100}%` }} />}
        </div>
        <div className="flex h-4 items-center justify-between gap-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          <span className="truncate">{ctx != null && point != null ? t("replay.room", { n: kilo(Math.max(0, point - ctx)) }) : ""}</span>
          <span className="shrink-0">{point != null ? t("replay.tick", { n: kilo(point) }) : t("replay.noPoint")}</span>
        </div>
      </div>
    </section>
  )
}

/**
 * The agent and the tools it reaches for, at that moment: a line runs to the tool in use,
 * subagents appear while they work, and while it waits for you the line runs to you.
 */
function Scene({ replay, now, state, seg }: Readonly<{ replay: ReplayData; now: number; state: ReplayState; seg: Seg | null }>) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  // More tools than places: the last place is for all the others, named while one is in use.
  const all = useMemo(() => toolsOf(replay, Infinity), [replay])
  const crowded = all.length > TOOLS_SHOWN
  const tools = crowded ? all.slice(0, TOOLS_SHOWN - 1) : all
  const busy = figuresAt(replay, now).busy
  // What to draw, as of the last render; and when each tool was last reached for, on the screen's clock.
  const scene = useRef<Omit<SceneInput, "phase" | "glow"> | null>(null)
  const reached = useRef(new Map<string, number>())

  const paint = (time: number, moving: boolean) => {
    const el = canvas.current
    const g = el?.getContext("2d")
    const input = scene.current
    if (!el || !g || !input) return
    // Drawn at the screen's own pixel density, so lines stay sharp.
    const dpr = window.devicePixelRatio || 1
    if (el.width !== Math.round(input.width * dpr)) {
      el.width = Math.round(input.width * dpr)
      el.height = Math.round(input.height * dpr)
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const glow = new Map<string, number>()
    if (moving) {
      for (const name of [input.seg, ...input.busy.map(row => segAt(row, input.now))].map(toolInUse)) if (name) reached.current.set(name, time)
      for (const [name, at] of reached.current) {
        const age = (time - at) / GLOW_MS
        if (age >= 1) reached.current.delete(name)
        else if (age > 0) glow.set(name, 1 - age)
      }
    }
    drawScene(g, { ...input, glow, phase: moving ? (time % TRAVEL_MS) / TRAVEL_MS : 0.5 })
  }

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const css = getComputedStyle(el)
    const colour = (name: string) => css.getPropertyValue(name).trim() || "#888"
    scene.current = {
      width: el.clientWidth,
      height: el.clientHeight,
      font: css.fontFamily,
      colours: {
        fg: colour("--color-foreground"), muted: colour("--color-muted-foreground"), line: colour("--color-border"), working: colour("--color-working"),
        waiting: colour("--color-waiting"), stuck: colour("--color-stuck"), error: colour("--color-error"), finished: colour("--color-finished"),
      },
      tools, others: crowded ? t("replay.otherTools", { n: all.length - tools.length }) : null, state, seg, busy, now,
      agentName: replay.rows[0]?.name ?? "agent",
      youLabel: t("replay.you"),
    }
    // For anyone who asks for less motion, the picture changes only when the moment does.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) paint(0, false)
  })
  // The dot runs on the screen's own clock, smoothly, whether the replay plays or stands still.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let id = requestAnimationFrame(function step(time) {
      paint(time, true)
      id = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <section aria-label={t("replay.scene")} className="overflow-hidden rounded-xl border bg-muted/40">
      <canvas ref={canvas} className="block h-64 w-full" />
    </section>
  )
}

/** The agent's plan at that moment, and what had happened up to it. */
function Story({ replay, events, now, figures, at, onSeek }: Readonly<{ replay: ReplayData; events: ReplayEvent[]; now: number; figures: ReturnType<typeof figuresAt>; at: (ms: number) => string; onSeek: (real: number) => void }>) {
  const { t, lang } = useI18n()
  const shown = events.filter(e => e.at <= now).slice(-EVENTS_SHOWN).reverse()
  // Room for the longest plan of the session and for a full list, from the start: what is
  // below stays where it is while the plan and the list fill up.
  const planRows = Math.max(1, ...replay.plans.map(p => p[1].length))
  const eventRows = Math.min(EVENTS_SHOWN, Math.max(1, events.length))
  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  const plan = figures.plan ?? []
  return (
    <section aria-label={t("replay.story")} className="space-y-5 rounded-xl border bg-card p-5">
      <div className={SUB}>
        <h3 className={H3}>{t("replay.plan")}</h3>
        {plan.length ? (
          <ul className="space-y-1.5 text-sm" style={{ minHeight: rowsHeight(planRows, 0.375) }}>
            {plan.map(([text, status], i) => (
              <li key={`${i}-${text}`} className="grid h-[1.4rem] grid-cols-[1.125rem_minmax(0,1fr)] items-center gap-2.5">
                <span aria-hidden className={cn("grid size-4 place-items-center rounded-[4px] border text-[10px] leading-none", BOX[status] ?? BOX.pending)}>
                  {status === "completed" ? "✓" : ""}
                </span>
                <Hint label={text} onlyWhenCut className={cn("block truncate", (status === "completed" || status === "cancelled") && "text-muted-foreground line-through")}>
                  {text}
                </Hint>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground" style={{ minHeight: replay.plans.length ? rowsHeight(planRows, 0.375) : undefined }}>{t("replay.noPlan")}</p>
        )}
      </div>
      <div className={SUB}>
        <h3 className={H3}>{t("replay.events")}</h3>
        <ol className="space-y-1 text-sm" style={{ minHeight: rowsHeight(eventRows, 0.25) }}>
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`} className="grid h-[1.4rem] grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2 overflow-hidden">
              {/* The time is the way back to that moment. */}
              <Hint
                label={`${at(e.at)} · ${t("replay.goTo")}`}
                render={<button type="button" onClick={() => onSeek(e.at)} />}
                className="cursor-pointer rounded-sm text-left font-mono text-xs text-muted-foreground tabular-nums underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {time.format(e.at)}
              </Hint>
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0">
                  {e.row && <span className="mr-1.5 text-muted-foreground">{e.row}:</span>}
                  {t(`replay.event.${e.kind}`, { ending: t(`replay.ending.${e.text}`) })}
                </span>
                {e.text && (e.kind === "tool" || e.kind === "waiting") && (
                  <Hint label={<span className="font-mono">{e.text}</span>} onlyWhenCut className="min-w-0 truncate font-mono text-code text-muted-foreground">
                    {e.text}
                  </Hint>
                )}
              </span>
            </li>
          ))}
          {!shown.length && <li className="text-muted-foreground">{t("replay.noEvents")}</li>}
        </ol>
      </div>
    </section>
  )
}

/** The height of n lines of small text (1.4rem each) with a gap between them, in rem. */
const rowsHeight = (n: number, gap: number) => `${n * 1.4 + (n - 1) * gap}rem`

const BOX: Record<string, string> = {
  completed: "border-finished bg-finished text-background",
  in_progress: "border-working ring-2 ring-working/25",
  pending: "border-muted-foreground/60",
}
