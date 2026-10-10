"use client"

import { PauseIcon, PlayIcon, RotateCcwIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { duration, stopwatch } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { clockOf, segAt, toolOf, type Replay as ReplayData, type ReplayRow, type ReplayState, type Seg } from "@/lib/replay"
import { cn } from "@/lib/utils"
import { Hint } from "./hint"
import { H3, SUB } from "./section"

// What one session played back and the whole bridge played back have in common: the player
// and its controls, the timeline, and the words for what an agent was doing.

/** Times real time: 1 plays as it happened. */
const SPEEDS = [1, 1.5, 2.5, 3, 30, 60, 180] as const
type Speed = (typeof SPEEDS)[number]
const SPEED_ITEMS = SPEEDS.map(s => ({ value: String(s), label: `${s}×` }))
const FRAME_MS = 125

export const BUBBLE: Partial<Record<ReplayState, string>> = { waiting: "ship.bubble.waiting", stuck: "ship.bubble.stuck", error: "ship.bubble.error", finished: "ship.bubble.finished" }
export const BUBBLE_BG: Partial<Record<ReplayState, string>> = { waiting: "bg-[#ffc04d]", stuck: "bg-[#ff9f68]", error: "bg-[#ff7a8a]", finished: "bg-[#9be7c4]" }

export type Clock = ReturnType<typeof clockOf>
/** What a clock is made from: when it starts and ends, and everything that happened between. */
type Played = Pick<ReplayData, "start" | "end" | "rows">

/** Where the playhead is, and everything that moves it. */
export function usePlayer(played: Played) {
  const [skip, setSkip] = useState(true)
  const clock = useMemo(() => clockOf(played as ReplayData, skip), [played, skip])
  const [play, setPlay] = useState(0) // ms of playback
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(60)

  // Playing: playback time moves at `speed` times real time, until the end.
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let id = 0
    const step = (time: number) => {
      const dt = time - last
      last = time
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

  const ended = play >= clock.length
  return {
    skip, clock, play, setPlay, playing, speed, setSpeed, ended,
    /** The real time the playhead is at. */
    now: clock.toReal(Math.min(play, clock.length)),
    toggleSkip: (on: boolean) => {
      // Stay at the same moment when the clock changes.
      const real = clock.toReal(play)
      setSkip(on)
      setPlay(clockOf(played as ReplayData, on).toPlay(real))
    },
    // To a moment, from any part of the page: a millisecond past it, so that what happened
    // then has happened, in the list as in the picture.
    goTo: (real: number) => setPlay(Math.min(clock.length, clock.toPlay(real) + 1)),
    togglePlay: () => {
      // At the end, playing again starts over.
      if (ended) setPlay(0)
      setPlaying(ended || !playing)
    },
  }
}

/** A moment of the past in full: the day, and the time to the second. */
export function useAt() {
  const { lang } = useI18n()
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    return (ms: number) => format.format(ms)
  }, [lang])
}

/** Says, wherever a replay is shown, that it is one: never taken for now. */
export function ReplayBadge() {
  const { t } = useI18n()
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      <RotateCcwIcon aria-hidden className="size-3.5" />
      {t("replay.badge")}
    </span>
  )
}

/**
 * The controls of a replay, in reach while the page scrolls.
 * @param moments  what the two step buttons go between, oldest first
 */
export function Transport({ player, moments, at }: Readonly<{ player: ReturnType<typeof usePlayer>; moments: { at: number }[]; at: (ms: number) => string }>) {
  const { t } = useI18n()
  const { clock, play, playing, now, speed, skip, ended } = player
  // A moment within a millisecond of the playhead is the playhead: going back twice goes back twice.
  const before = moments.findLast(e => e.at < now - 2)
  const after = moments.find(e => e.at > now + 1)
  let playLabel = "replay.play"
  if (playing) playLabel = "replay.pause"
  else if (ended) playLabel = "replay.again"

  return (
    <>
      <fieldset className="z-10 -mx-1 flex min-w-0 lg:sticky lg:top-[env(safe-area-inset-top,0px)] flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-card/95 px-3 py-2.5 backdrop-blur">
        <legend className="sr-only">{t("replay.player")}</legend>
        <Button size="sm" className="w-28" onClick={player.togglePlay}>
          {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
          {t(playLabel)}
        </Button>
        <div className="flex items-center gap-0.5">
          <Hint label={t("replay.previous")} render={<Button size="icon-sm" variant="ghost" aria-label={t("replay.previous")} disabled={!before} onClick={() => before && player.goTo(before.at)} />}>
            <SkipBackIcon aria-hidden />
          </Hint>
          <Hint label={t("replay.next")} render={<Button size="icon-sm" variant="ghost" aria-label={t("replay.next")} disabled={!after} onClick={() => after && player.goTo(after.at)} />}>
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
          onChange={e => player.setPlay(Number(e.target.value))}
          aria-label={t("replay.position")}
          className="h-2 min-w-40 flex-1 cursor-pointer accent-[var(--color-working)]"
        />
        <label className="inline-flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("replay.speed")}</span>
          <Select value={String(speed)} onValueChange={next => player.setSpeed(SPEEDS.find(s => String(s) === next) ?? speed)} items={SPEED_ITEMS}>
            <SelectTrigger size="sm" aria-label={t("replay.speed")} className="w-22 tabular-nums">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPEED_ITEMS.map(item => (
                <SelectItem key={item.value} value={item.value} className="tabular-nums">
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <Switch checked={skip} onCheckedChange={player.toggleSkip} aria-describedby="replay-skip-note" />
          {t("replay.skip")}
        </label>
      </fieldset>
      <p id="replay-skip-note" className="-mt-5 text-xs text-muted-foreground">
        {skip && clock.gaps.length ? t("replay.skipNote", { n: clock.gaps.length, t: duration(clock.gaps.reduce((n, g) => n + g[1] - g[0], 0)) }) : t("replay.realNote")}
      </p>
    </>
  )
}

/** A frame count that moves eight times a second, for the pixels; still for anyone who asks for less motion. */
export function useFrame() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = setInterval(() => setFrame(f => f + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [])
  return frame
}

type Translate = ReturnType<typeof useI18n>["t"]

/** What the session was doing, in words: its state when it was not at work, else the step, or its subagent's. */
export function doingAt(t: Translate, state: ReplayState, seg: Seg | null, sub: ReplayData["rows"][number] | null, now: number) {
  if (state === "finished" || state === "error" || state === "idle") return t(`replay.doing.${state}`)
  if (!seg) return t("replay.doing.between")
  const subSeg = sub ? segAt(sub, now) : null
  // Waiting on a task means waiting on the subagent: say what that one is doing.
  if (sub && subSeg && toolOf(seg) === "task") return t("replay.doing.sub", { name: sub.name, what: subSeg[3] || t(`replay.kind.${subSeg[2]}`) })
  const what = t(`replay.kind.${seg[2]}`)
  return seg[3] ? t("replay.doing.with", { what, detail: seg[3] }) : what
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

/** A row of the timeline: a row of a replay, with what to say under its name when that is not its kind. */
export type TimelineRow = ReplayRow & { caption?: string }

/** Every row over time, at playback scale, with the skipped silences marked. Click to go there. */
export function Timeline({ rows, compactions, clock, play, onSeek, at }: Readonly<{ rows: TimelineRow[]; compactions: number[]; clock: Clock; play: number; onSeek: (ms: number) => void; at: (ms: number) => string }>) {
  const { t } = useI18n()
  const [hover, setHover] = useState<string | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const L = 120
  const R = 990
  const TOP = 22
  const ROW = 34
  const BAR = 18
  const bottom = TOP + ROW * rows.length
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
    const row = rows[Math.floor(((y - TOP) / ROW))]
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
          {rows.map((row, i) => {
            const y = TOP + i * ROW + (ROW - BAR) / 2
            return (
              <g key={row.id}>
                <text x={0} y={y + 8} className="fill-foreground text-[12px]">{row.name.length > 14 ? `${row.name.slice(0, 13)}…` : row.name}</text>
                <text x={0} y={y + 21} className="fill-muted-foreground text-[10px]">{row.caption ?? t(row.sub ? "replay.subagent" : "replay.main")}</text>
                {ORDER.flatMap(kind => row.segs.filter(s => s[2] === kind).map((s, j) => (
                  <rect key={`${kind}-${j}`} x={x(s[0])} y={kind === "waiting" ? y - 2 : y} width={Math.max(1, x(s[1]) - x(s[0]))} height={kind === "waiting" ? BAR + 4 : BAR} rx={2} fill={KIND_FILL[kind]} />
                )))}
              </g>
            )
          })}
          {compactions.map(c => (
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

export function Loading() {
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
