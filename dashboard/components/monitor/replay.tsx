"use client"

import { ChartColumnIcon, HistoryIcon, PauseIcon, PlayIcon, RotateCcwIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { duration, kilo, stopwatch } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useReplay, useReplaySessions } from "@/lib/live"
import { clockOf, eventsOf, figuresAt, screenAt, segAt, stateAt, toolOf, type Replay as ReplayData, type ReplayEvent, type ReplayState, type Seg } from "@/lib/replay"
import { drawScene, toolsOf } from "@/lib/replay-scene"
import { layout, lookOf } from "@/lib/ship"
import { drawShip } from "@/lib/ship-draw"
import { cn } from "@/lib/utils"
import { Hint } from "./hint"
import { Facts, H3, SUB, TAB } from "./section"
import { SessionFilter } from "./session-filter"
import { StateBadge } from "./state"

/** Times real time: 1 plays a session as it happened. */
const SPEEDS = [1, 30, 60, 180] as const
/** The events kept in view; the list keeps room for this many, so it never grows while playing. */
const EVENTS_SHOWN = 7
const FRAME_MS = 125
/** Pixels of sky cut off the top of the one station. */
const SKY_CUT = 30
const BUBBLE: Partial<Record<ReplayState, string>> = { waiting: "ship.bubble.waiting", stuck: "ship.bubble.stuck", error: "ship.bubble.error", finished: "ship.bubble.finished" }
const BUBBLE_BG: Partial<Record<ReplayState, string>> = { waiting: "bg-[#ffc04d]", stuck: "bg-[#ff9f68]", error: "bg-[#ff7a8a]", finished: "bg-[#9be7c4]" }

/**
 * One session played back: the bridge, the panel of that moment, the agent and its tools,
 * and a timeline, all at the same playhead. Labelled as a replay everywhere, so a raised
 * hand here is never taken for someone waiting now.
 */
export function Replay({ session, onSession }: Readonly<{ session: string | null; onSession: (id: string | null) => void }>) {
  const { t } = useI18n()
  const sessions = useReplaySessions(true)
  const id = session ?? sessions?.[0]?.id ?? null
  const { replay, failed } = useReplay(id)

  return (
    <div className={TAB}>
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
    </div>
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
  const { t, lang } = useI18n()
  const [skip, setSkip] = useState(true)
  const clock = useMemo(() => clockOf(replay, skip), [replay, skip])
  const [play, setPlay] = useState(0) // ms of playback
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(60)
  const frame = useFrame()

  // Playing: playback time moves at `speed` times real time, until the end.
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let id = 0
    const step = (now: number) => {
      const dt = now - last
      last = now
      setPlay(p => {
        const next = Math.min(clock.length, p + dt * speed)
        if (next >= clock.length) setPlaying(false)
        return next
      })
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [playing, speed, clock.length])

  const now = clock.toReal(Math.min(play, clock.length))
  const { state, seg } = stateAt(replay, now)
  const figures = figuresAt(replay, now)
  const events = useMemo(() => eventsOf(replay), [replay])
  // A moment within a millisecond of the playhead is the playhead: going back twice goes back twice.
  const before = events.findLast(e => e.at < now - 1)
  const after = events.find(e => e.at > now + 1)
  const at = (ms: number) => new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(ms)
  const toggleSkip = (on: boolean) => {
    // Stay at the same moment of the session when the clock changes.
    const real = clock.toReal(play)
    setSkip(on)
    setPlay(clockOf(replay, on).toPlay(real))
  }
  const ended = play >= clock.length
  const togglePlay = () => {
    // At the end, playing again starts over.
    if (ended) setPlay(0)
    setPlaying(ended || !playing)
  }
  let playLabel = "replay.play"
  if (playing) playLabel = "replay.pause"
  else if (ended) playLabel = "replay.again"

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-2xl font-semibold break-words">{replay.session.title || replay.session.id}</h2>
          <p className="font-mono text-code text-muted-foreground [overflow-wrap:anywhere]">{replay.session.project}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          <RotateCcwIcon aria-hidden className="size-3.5" />
          {t("replay.badge")}
        </span>
      </div>

      {/* The player stays in reach while the page scrolls. */}
      <fieldset className="z-10 -mx-1 flex min-w-0 lg:sticky lg:top-[env(safe-area-inset-top,0px)] flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-card/95 px-3 py-2.5 backdrop-blur">
        <legend className="sr-only">{t("replay.player")}</legend>
        <Button size="sm" className="w-28" onClick={togglePlay}>
          {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
          {t(playLabel)}
        </Button>
        <div className="flex items-center gap-0.5">
          <Hint label={t("replay.previous")} render={<Button size="icon-sm" variant="ghost" aria-label={t("replay.previous")} disabled={!before} onClick={() => before && setPlay(clock.toPlay(before.at))} />}>
            <SkipBackIcon aria-hidden />
          </Hint>
          <Hint label={t("replay.next")} render={<Button size="icon-sm" variant="ghost" aria-label={t("replay.next")} disabled={!after} onClick={() => after && setPlay(clock.toPlay(after.at))} />}>
            <SkipForwardIcon aria-hidden />
          </Hint>
        </div>
        {/* A fixed width and a fixed shape of text: the running time moves nothing beside it. */}
        <div className="grid w-52 shrink-0 leading-tight">
          <span className="font-mono text-sm whitespace-nowrap tabular-nums">
            {stopwatch(play, clock.length)} / {stopwatch(clock.length)}
          </span>
          <span className="truncate text-xs text-muted-foreground tabular-nums">{t("replay.at", { t: at(now) })}</span>
        </div>
        <input
          type="range"
          min={0}
          max={clock.length}
          step={1000}
          value={Math.round(play)}
          onChange={e => setPlay(Number(e.target.value))}
          aria-label={t("replay.position")}
          className="h-2 min-w-40 flex-1 cursor-pointer accent-[var(--color-working)]"
        />
        <fieldset className="inline-flex rounded-lg border bg-card p-0.5">
          <legend className="sr-only">{t("replay.speed")}</legend>
          {SPEEDS.map(s => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)} className={cn("h-7 rounded-md px-2.5 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring", speed === s ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              {s}×
            </button>
          ))}
        </fieldset>
        <label className="inline-flex items-center gap-2 text-sm">
          <Switch checked={skip} onCheckedChange={toggleSkip} aria-describedby="replay-skip-note" />
          {t("replay.skip")}
        </label>
      </fieldset>
      <p id="replay-skip-note" className="-mt-5 text-xs text-muted-foreground">
        {skip && clock.gaps.length ? t("replay.skipNote", { n: clock.gaps.length, t: duration(clock.gaps.reduce((n, g) => n + g[1] - g[0], 0)) }) : t("replay.realNote")}
      </p>

      {/* Two columns of about the same height on a wide screen; on a phone, the picture and then what it means. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start">
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-1">
            <Station replay={replay} now={now} play={play} state={state} seg={seg} busy={figures.busy.length} frame={frame} clock={clock} />
          </div>
          <div className="order-3">
            <Scene replay={replay} now={now} state={state} seg={seg} frame={frame} />
          </div>
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-2">
            <Moment replay={replay} now={now} state={state} seg={seg} figures={figures} />
          </div>
          <div className="order-4">
            <Story replay={replay} events={events} now={now} figures={figures} at={at} />
          </div>
        </div>
      </div>

      <Timeline replay={replay} clock={clock} play={play} onSeek={setPlay} at={at} />
    </>
  )
}

/** A frame count that moves eight times a second, for the pixels; still for anyone who asks for less motion. */
function useFrame() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = setInterval(() => setFrame(f => f + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [])
  return frame
}

type Clock = ReturnType<typeof clockOf>

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

type Translate = ReturnType<typeof useI18n>["t"]

/** What the session was doing, in words: its state when it was not at work, else the step, or its subagent's. */
function doingAt(t: Translate, state: ReplayState, seg: Seg | null, sub: ReplayData["rows"][number] | null, now: number) {
  if (state === "finished" || state === "error" || state === "idle") return t(`replay.doing.${state}`)
  if (!seg) return t("replay.doing.between")
  const subSeg = sub ? segAt(sub, now) : null
  // Waiting on a task means waiting on the subagent: say what that one is doing.
  if (sub && subSeg && toolOf(seg) === "task") return t("replay.doing.sub", { name: sub.name, what: subSeg[3] || t(`replay.kind.${subSeg[2]}`) })
  const what = t(`replay.kind.${seg[2]}`)
  return seg[3] ? t("replay.doing.with", { what, detail: seg[3] }) : what
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StateBadge state={state} label={t(`state.${state}`)} />
        {seg && <span className="text-sm text-muted-foreground tabular-nums">{t("replay.for", { t: duration(now - seg[0]) })}</span>}
      </div>
      <Hint label={doing} onlyWhenCut render={<p />} className="line-clamp-3 min-h-[4.5em] text-base break-words">
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
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground tabular-nums">
          <span>{t("health.context")}</span>
          <span>{contextText}</span>
        </div>
        <div className="relative h-2.5 rounded-full bg-muted">
          {ctx != null && limit != null && <span className={cn("absolute inset-y-0 left-0 rounded-full", point != null && ctx >= point * 0.85 ? "bg-waiting" : "bg-working")} style={{ width: `${Math.min(100, (ctx / limit) * 100)}%` }} />}
          {point != null && limit != null && <span aria-hidden className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground" style={{ left: `${(point / limit) * 100}%` }} />}
        </div>
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground tabular-nums">
          <span>{ctx != null && point != null ? t("replay.room", { n: kilo(Math.max(0, point - ctx)) }) : ""}</span>
          <span>{point != null ? t("replay.tick", { n: kilo(point) }) : t("replay.noPoint")}</span>
        </div>
      </div>
    </section>
  )
}

/**
 * The agent and the tools it reaches for, at that moment: a line runs to the tool in use,
 * subagents appear while they work, and while it waits for you the line runs to you.
 */
function Scene({ replay, now, state, seg, frame }: Readonly<{ replay: ReplayData; now: number; state: ReplayState; seg: Seg | null; frame: number }>) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const tools = useMemo(() => toolsOf(replay), [replay])
  const busy = figuresAt(replay, now).busy
  useEffect(() => {
    const el = canvas.current
    const g = el?.getContext("2d")
    if (!el || !g) return
    const css = getComputedStyle(el)
    const colour = (name: string) => css.getPropertyValue(name).trim() || "#888"
    // Drawn at the screen's own pixel density, so lines stay sharp.
    const dpr = window.devicePixelRatio || 1
    const w = el.clientWidth
    const h = el.clientHeight
    if (el.width !== Math.round(w * dpr)) {
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawScene(g, {
      width: w,
      height: h,
      font: css.fontFamily,
      colours: {
        fg: colour("--color-foreground"), muted: colour("--color-muted-foreground"), line: colour("--color-border"), working: colour("--color-working"),
        waiting: colour("--color-waiting"), stuck: colour("--color-stuck"), error: colour("--color-error"), finished: colour("--color-finished"),
      },
      tools, state, seg, busy, now, frame,
      agentName: replay.rows[0]?.name ?? "agent",
      youLabel: t("replay.you"),
    })
  })
  return (
    <section aria-label={t("replay.scene")} className="overflow-hidden rounded-xl border bg-muted/40">
      <canvas ref={canvas} className="block h-64 w-full" />
    </section>
  )
}

/** The agent's plan at that moment, and what had happened up to it. */
function Story({ replay, events, now, figures, at }: Readonly<{ replay: ReplayData; events: ReplayEvent[]; now: number; figures: ReturnType<typeof figuresAt>; at: (ms: number) => string }>) {
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
              <li key={`${i}-${text}`} className="grid grid-cols-[1.125rem_minmax(0,1fr)] items-start gap-2.5">
                <span aria-hidden className={cn("mt-1 grid size-4 place-items-center rounded-[4px] border text-[10px] leading-none", BOX[status] ?? BOX.pending)}>
                  {status === "completed" ? "✓" : ""}
                </span>
                <span className={cn("break-words", (status === "completed" || status === "cancelled") && "text-muted-foreground line-through")}>{text}</span>
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
            <li key={`${e.at}-${i}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
              <Hint label={at(e.at)} className="font-mono text-xs text-muted-foreground tabular-nums">
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

const KIND_FILL: Record<string, string> = {
  reading: "var(--color-part-1)",
  thinking: "var(--color-part-2)",
  writing: "var(--color-part-3)",
  tool: "var(--color-part-4)",
  compact: "var(--color-idle)",
  waiting: "url(#replay-hatch)",
}
const ORDER = ["reading", "thinking", "writing", "tool", "compact", "waiting"] as const

/** The first label starts at its tick, the last ends at it, the rest are centred on it. */
function anchorOf(p: number, length: number) {
  if (p === 0) return "start"
  return p === length ? "end" : "middle"
}

/** Every row of the session over time, at playback scale, with the skipped silences marked. Click to go there. */
function Timeline({ replay, clock, play, onSeek, at }: Readonly<{ replay: ReplayData; clock: Clock; play: number; onSeek: (ms: number) => void; at: (ms: number) => string }>) {
  const { t } = useI18n()
  const [hover, setHover] = useState<string | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const L = 120
  const R = 990
  const TOP = 22
  const ROW = 34
  const BAR = 18
  const bottom = TOP + ROW * replay.rows.length
  const x = (real: number) => L + (clock.toPlay(real) / clock.length) * (R - L)
  const ticks = Array.from({ length: 6 }, (_, i) => (clock.length * i) / 5)
  const short = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
  const playAt = (clientX: number) => {
    const box = svg.current?.getBoundingClientRect()
    if (!box) return null
    const vx = ((clientX - box.left) / box.width) * 1000
    return Math.max(0, Math.min(clock.length, ((vx - L) / (R - L)) * clock.length))
  }
  const describeAt = (p: number, y: number) => {
    const real = clock.toReal(p)
    const row = replay.rows[Math.floor(((y - TOP) / ROW))]
    const s = row ? segAt(row, real) : null
    const gap = clock.gaps.find(([a, b]) => real >= a && real < b)
    let what = t("replay.goTo")
    if (s) {
      const kind = t(`replay.kind.${s[2]}`)
      const doing = s[3] ? `${kind}: ${s[3]}` : kind
      what = `${row?.name} · ${doing} · ${duration(s[1] - s[0])}`
    } else if (gap) {
      what = t("replay.skipped", { t: duration(gap[1] - gap[0]) })
    }
    return `${at(real)} · ${what}`
  }

  return (
    <section className={cn(SUB, "rounded-xl border bg-card p-5")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className={H3}>{t("replay.timeline")}</h3>
        <p className="text-xs text-muted-foreground">{t("replay.timelineNote")}</p>
      </div>
      <div className="overflow-x-auto">
        <svg
          ref={svg}
          viewBox={`0 0 1000 ${bottom + 22}`}
          className="block h-auto w-full min-w-[40rem] cursor-pointer"
          role="img"
          aria-label={t("replay.timeline")}
          onClick={e => {
            const p = playAt(e.clientX)
            if (p != null) onSeek(p)
          }}
          onMouseMove={e => {
            const p = playAt(e.clientX)
            const box = svg.current?.getBoundingClientRect()
            if (p == null || !box) return
            setHover(describeAt(p, ((e.clientY - box.top) / box.height) * (bottom + 22)))
          }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <pattern id="replay-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--color-waiting)" opacity="0.35" />
              <rect width="3" height="6" fill="var(--color-waiting)" />
            </pattern>
          </defs>
          {ticks.map(p => (
            <g key={p}>
              <line x1={L + (p / clock.length) * (R - L)} x2={L + (p / clock.length) * (R - L)} y1={TOP - 4} y2={bottom} stroke="var(--color-border)" />
              <text x={L + (p / clock.length) * (R - L)} y={bottom + 15} textAnchor={anchorOf(p, clock.length)} className="fill-muted-foreground font-mono text-[11px]">
                {short.format(clock.toReal(p))}
              </text>
            </g>
          ))}
          {clock.gaps.map(([a, b]) => (
            <g key={a}>
              <rect x={x(a)} y={TOP - 8} width={Math.max(2, x(b) - x(a))} height={bottom - TOP + 10} fill="var(--color-muted)" stroke="var(--color-border)" strokeDasharray="3 3" />
              {x(b) - x(a) >= 64 && (
                <text x={(x(a) + x(b)) / 2} y={TOP - 11} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {t("replay.skipped", { t: duration(b - a) })}
                </text>
              )}
            </g>
          ))}
          {replay.rows.map((row, i) => {
            const y = TOP + i * ROW + (ROW - BAR) / 2
            return (
              <g key={row.id}>
                <text x={0} y={y + 8} className="fill-foreground text-[12px]">{row.name.length > 14 ? `${row.name.slice(0, 13)}…` : row.name}</text>
                <text x={0} y={y + 21} className="fill-muted-foreground text-[10px]">{t(row.sub ? "replay.subagent" : "replay.main")}</text>
                {ORDER.flatMap(kind => row.segs.filter(s => s[2] === kind).map((s, j) => (
                  <rect key={`${kind}-${j}`} x={x(s[0])} y={kind === "waiting" ? y - 2 : y} width={Math.max(1, x(s[1]) - x(s[0]))} height={kind === "waiting" ? BAR + 4 : BAR} rx={2} fill={KIND_FILL[kind]} />
                )))}
              </g>
            )
          })}
          {replay.compactions.map(c => (
            <line key={c} x1={x(c)} x2={x(c)} y1={TOP - 2} y2={bottom} stroke="var(--color-foreground)" strokeWidth={1.2} strokeDasharray="3 3" />
          ))}
          <line x1={L + (play / clock.length) * (R - L)} x2={L + (play / clock.length) * (R - L)} y1={TOP - 12} y2={bottom + 2} stroke="var(--color-foreground)" strokeWidth={2} />
        </svg>
      </div>
      <p className="min-h-[1.5em] text-xs text-muted-foreground" aria-live="off">{hover ?? t("replay.hoverHint")}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t("replay.legend")}>
        {ORDER.map(kind => (
          <li key={kind} className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" aria-hidden className="shrink-0 rounded-[2px]">
              <rect width="10" height="10" fill={KIND_FILL[kind]} />
            </svg>
            {t(`replay.kind.${kind}`)}
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden className="shrink-0">
            <line x1="5" x2="5" y1="0" y2="10" stroke="currentColor" strokeDasharray="2 2" />
          </svg>
          {t("replay.compactLine")}
        </li>
      </ul>
    </section>
  )
}

function Loading() {
  return (
    <div className="space-y-6" aria-hidden>
      <Skeleton className="h-10 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  )
}

