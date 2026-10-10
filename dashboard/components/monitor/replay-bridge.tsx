"use client"

import { RotateCcwIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { crewAt, momentsOf, playedOf, rowsOf, tagOf, TALLY_ORDER, tallyOf, type Bridge, type CrewMember } from "@/lib/bridge"
import { duration } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useBridge, useReplayDays } from "@/lib/live"
import { screenAt } from "@/lib/replay"
import { layout, lookOf, STATION_H, STATION_W } from "@/lib/ship"
import { drawShip } from "@/lib/ship-draw"
import { cn } from "@/lib/utils"
import { Hint } from "./hint"
import { BUBBLE, BUBBLE_BG, doingAt, Loading, ReplayBadge, Timeline, Transport, useAt, useFrame, usePlayer, type Clock } from "./replay-player"
import { H3, SUB } from "./section"
import { useColumns } from "./ship"
import { StateBadge } from "./state"

/** A day as people say it: Friday 9 October 2026. Built from its parts, so no time zone moves it. */
function dayText(day: string, lang: string, long: boolean) {
  const [y, m, d] = day.split("-").map(Number)
  const options: Intl.DateTimeFormatOptions = long ? { weekday: "long", day: "numeric", month: "long", year: "numeric" } : { weekday: "short", day: "numeric", month: "short" }
  return new Intl.DateTimeFormat(lang, options).format(new Date(y, m - 1, d))
}

/**
 * Every session of one day played back side by side: the bridge as it stood at each
 * moment. A picture of many replays at once; each station leads to its session's own.
 */
export function BridgeReplay({ onOpen }: Readonly<{ onOpen: (id: string) => void }>) {
  const { t, lang } = useI18n()
  const days = useReplayDays(true)
  const [picked, setPicked] = useState<string | null>(null)
  const day = picked ?? days?.[0]?.day ?? null
  const { bridge, failed } = useBridge(day)
  const items = (days ?? []).map(d => ({ value: d.day, label: t("bridge.dayOption", { day: dayText(d.day, lang, false), n: d.sessions }) }))

  return (
    <>
      <div className="space-y-2.5">
        {items.length > 0 && day && (
          <Select value={day} onValueChange={next => next && setPicked(String(next))} items={items}>
            <SelectTrigger size="sm" aria-label={t("bridge.day")} className="max-w-full min-w-44 sm:max-w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map(item => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="max-w-prose text-xs text-muted-foreground">{t("bridge.source")}</p>
      </div>
      {days && !days.length && <p className="text-sm text-muted-foreground">{t("bridge.none")}</p>}
      {failed && !bridge && <p className="text-sm text-error">{t("replay.failed")}</p>}
      {day && !bridge && !failed && <Loading />}
      {bridge && bridge.sessions.length > 0 && <BridgePlayer key={bridge.day} bridge={bridge} onOpen={onOpen} />}
    </>
  )
}

function BridgePlayer({ bridge, onOpen }: Readonly<{ bridge: Bridge; onOpen: (id: string) => void }>) {
  const { t, lang } = useI18n()
  const played = useMemo(() => playedOf(bridge), [bridge])
  const rows = useMemo(() => rowsOf(bridge), [bridge])
  const moments = useMemo(() => momentsOf(bridge), [bridge])
  const player = usePlayer(played)
  const { clock, play, now } = player
  const at = useAt()
  const frame = useFrame()
  const crew = crewAt(bridge, now)
  const tally = tallyOf(crew)

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-2xl font-semibold break-words">{dayText(bridge.day, lang, true)}</h2>
          <p className="text-sm text-muted-foreground">{t("bridge.count", { n: bridge.sessions.length + bridge.more })}</p>
        </div>
        <ReplayBadge />
      </div>

      <Transport player={player} moments={moments} at={at} />

      {/* How many in each state, every state always there: the line never changes its shape. */}
      <ul aria-label={t("bridge.tally")} className="flex flex-wrap gap-x-5 gap-y-2">
        {TALLY_ORDER.map(state => (
          <li key={state} className={cn("inline-flex items-center gap-2 text-sm", !tally[state] && "opacity-45")}>
            <StateBadge state={state} label={t(`state.${state}`)} />
            <span className="w-5 font-medium tabular-nums">{tally[state]}</span>
          </li>
        ))}
      </ul>

      <Stations bridge={bridge} crew={crew} play={play} now={now} frame={frame} clock={clock} onOpen={onOpen} />
      {bridge.more > 0 && <p className="-mt-3 text-sm text-muted-foreground">{t("bridge.more", { n: bridge.more })}</p>}

      <section aria-label={t("bridge.each")} className={cn(SUB, "rounded-xl border bg-card p-5")}>
        <h3 className={H3}>{t("bridge.each")}</h3>
        <ul className="divide-y">
          {crew.map(member => (
            <CrewRow key={member.replay.session.id} member={member} tag={tagOf(member.replay, bridge.sessions)} now={now} onOpen={onOpen} />
          ))}
        </ul>
      </section>

      <Timeline rows={rows} compactions={[]} clock={clock} play={play} onSeek={player.setPlay} at={at} />
    </>
  )
}

/** The bridge at that moment: the same drawing as the live Ship, a station a session. */
function Stations({ bridge, crew, play, now, frame, clock, onOpen }: Readonly<{ bridge: Bridge; crew: CrewMember[]; play: number; now: number; frame: number; clock: Clock; onOpen: (id: string) => void }>) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const columns = useColumns()
  const { stations, width, height } = layout(crew.length, columns)
  useEffect(() => {
    const g = canvas.current?.getContext("2d")
    if (!g) return
    drawShip(g, {
      width, height, mcp: [], frame, now: play, still: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      stations: crew.map((member, i) => {
        const { replay, state, seg, context } = member
        const limit = replay.contextLimit
        return {
          ...stations[i],
          screen: screenAt(state, seg),
          state,
          look: lookOf(replay.session.id),
          fuel: { fill: context != null && limit ? Math.min(1, context / limit) : null, tick: replay.compactAt && limit ? replay.compactAt / limit : null, high: context != null && replay.compactAt != null && context >= replay.compactAt * 0.85 },
          drones: member.busy,
          selected: false,
          // The puff is timed in playback, so it shows at any speed.
          compactedAt: member.compactedAt == null ? null : clock.toPlay(member.compactedAt),
        }
      }),
    })
  })
  const pct = (n: number, of: number) => `${(n / of) * 100}%`

  return (
    <div className="overflow-hidden rounded-xl border-4 border-[#2c3557] bg-[#070a18] shadow-[0_0_0_1px_var(--color-border)]">
      <div className="relative">
        <canvas ref={canvas} width={width} height={height} className="block h-auto w-full [image-rendering:pixelated]" />
        <span className="absolute top-2 left-2 bg-[#0d1022] px-1.5 font-mono text-2xs tracking-wider text-[#e9edff]">REPLAY</span>
        <ul className="absolute inset-0" aria-label={t("bridge.stations")}>
          {crew.map((member, i) => {
            const { replay, state, seg } = member
            const tag = tagOf(replay, bridge.sessions)
            const bubble = BUBBLE[state]
            const title = replay.session.title || replay.session.id
            return (
              <li key={replay.session.id} className="absolute" style={{ left: pct(stations[i].x + 8, width), top: pct(stations[i].y, height), width: pct(STATION_W - 16, width), height: pct(STATION_H - 6, height) }}>
                <Hint
                  label={
                    <span className="grid gap-0.5">
                      <span className="font-mono">{replay.session.project}</span>
                      <span className="font-medium">{title}</span>
                      <span className="text-background/70">{t("bridge.open")}</span>
                    </span>
                  }
                  render={<button type="button" onClick={() => onOpen(replay.session.id)} aria-label={t("bridge.station", { title, state: t(`state.${state}`) })} />}
                  className="group relative block size-full cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  {bubble && (
                    <span className={cn("absolute top-0 left-1/2 max-w-full -translate-x-1/2 truncate px-1.5 py-px text-[clamp(0.625rem,1.4vw,0.75rem)] leading-snug font-medium text-[#0d1022] shadow-[0_-2px_0_#0d1022,0_2px_0_#0d1022,-2px_0_0_#0d1022,2px_0_0_#0d1022]", BUBBLE_BG[state])}>
                      {t(bubble, { t: seg ? duration(now - seg[0]) : "" })}
                    </span>
                  )}
                  <span className="absolute bottom-0 left-1/2 max-w-[calc(100%-4px)] -translate-x-1/2 truncate bg-[#0d1022] px-1.5 font-mono text-[clamp(0.5625rem,1.2vw,0.6875rem)] leading-relaxed text-[#e9edff] group-hover:bg-[#2c3557]">
                    {tag}
                  </span>
                </Hint>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** One session at that moment, in words: a line of fixed height, so the list never moves. */
function CrewRow({ member, tag, now, onOpen }: Readonly<{ member: CrewMember; tag: string; now: number; onOpen: (id: string) => void }>) {
  const { t } = useI18n()
  const { replay, state, seg, begun } = member
  const doing = begun ? doingAt(t, state, seg, member.sub, now) : t("bridge.notBegun")
  return (
    <li className="grid h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,14rem)_8.5rem_minmax(0,1fr)_auto]">
      <Hint label={replay.session.title || replay.session.id} onlyWhenCut className="block truncate text-sm font-medium">
        {tag}
      </Hint>
      <span className="hidden sm:block">
        <StateBadge state={state} label={t(`state.${state}`)} />
      </span>
      <Hint label={doing} onlyWhenCut className="hidden truncate text-sm text-muted-foreground sm:block">
        {doing}
      </Hint>
      <span className="flex items-center gap-3">
        <span className="sm:hidden">
          <StateBadge state={state} label={t(`state.${state}`)} />
        </span>
        <button type="button" onClick={() => onOpen(replay.session.id)} aria-label={t("bridge.openOf", { title: replay.session.title || replay.session.id })} className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          <RotateCcwIcon aria-hidden className="size-3.5" />
          <span className="hidden sm:inline">{t("links.replay")}</span>
        </button>
      </span>
    </li>
  )
}
