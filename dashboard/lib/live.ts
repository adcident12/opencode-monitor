"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import type { ConfigChange, HistoryEvent, HistoryPage, SessionChoice, SetupReport, Snapshot, Stats } from "./types"

/** Snapshots pushed by the monitor over server-sent events. */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [skew, setSkew] = useState(0) // browser clock minus server clock

  useEffect(() => {
    const source = new EventSource("/api/events")
    source.onmessage = event => {
      const next = JSON.parse(event.data) as Snapshot
      setSkew(Date.now() - next.now)
      setSnapshot(next)
      setConnected(true)
    }
    // EventSource reconnects by itself; meanwhile show that the feed is down.
    source.onerror = () => setConnected(false)
    return () => source.close()
  }, [])

  return { snapshot, connected, skew }
}

/** Server time, re-rendered every second, for the running clocks. */
export function useNow(skew: number): number {
  const [now, setNow] = useState(() => Date.now() - skew)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() - skew), 1000)
    return () => clearInterval(timer)
  }, [skew])
  return now
}

const sessionQuery = (session: string | null) => (session ? `session=${encodeURIComponent(session)}` : "")

export const HISTORY_PAGE = 100
const cursorOf = (e: HistoryEvent) => `${e.t}:${e.id}`

type HistoryState = { key: string; events: HistoryEvent[]; more: number; truncated: boolean; loading: boolean }

/**
 * History, a page at a time. The first page loads when the view opens or a filter changes;
 * after that, a change in the live count fetches only what arrived since the newest entry
 * shown, and "load older" fetches the page below the oldest. Nothing already on screen moves.
 */
export function useHistory(count: number | null, enabled: boolean, session: string | null = null, attention = false) {
  const key = `${session ?? ""}|${attention ? 1 : 0}`
  const filter = `${sessionQuery(session)}${attention ? "&attention=1" : ""}`
  const [state, setState] = useState<HistoryState>({ key, events: [], more: 0, truncated: false, loading: true })
  const current = state.key === key ? state : null
  const newest = current?.events[0]
  const newestCursor = newest ? cursorOf(newest) : null

  // First page, for this filter.
  useEffect(() => {
    if (!enabled || count == null) return
    let live = true
    fetch(`/api/history?limit=${HISTORY_PAGE}&${filter}`)
      .then(res => res.json() as Promise<HistoryPage>)
      .then(page => live && setState({ key, events: page.events, more: page.more, truncated: page.truncated, loading: false }))
      .catch(() => live && setState(s => ({ ...s, loading: false })))
    return () => {
      live = false
    }
    // count is left out on purpose: a new entry is fetched below, not by starting over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, count == null])

  // New entries at the top, when the live count says there are some.
  useEffect(() => {
    if (!enabled || count == null || !newestCursor) return
    let live = true
    fetch(`/api/history?limit=500&after=${newestCursor}&${filter}`)
      .then(res => res.json() as Promise<HistoryPage>)
      .then(page => {
        if (!live || !page.events.length) return
        setState(s => (s.key === key && s.events[0] && cursorOf(s.events[0]) === newestCursor ? { ...s, events: [...page.events, ...s.events] } : s))
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count])

  const loadOlder = () => {
    const oldest = current?.events.at(-1)
    if (!oldest || !current || current.loading) return
    setState(s => ({ ...s, loading: true }))
    fetch(`/api/history?limit=${HISTORY_PAGE}&before=${cursorOf(oldest)}&${filter}`)
      .then(res => res.json() as Promise<HistoryPage>)
      .then(page => setState(s => (s.key === key ? { ...s, events: [...s.events, ...page.events], more: page.more, truncated: page.truncated, loading: false } : s)))
      .catch(() => setState(s => ({ ...s, loading: false })))
  }

  // Entries of another filter are not shown as if they were this one's.
  return {
    events: current?.events ?? [],
    more: current?.more ?? 0,
    truncated: current?.truncated ?? false,
    loading: current?.loading ?? true,
    loadOlder,
  }
}

/** Every session the history has an entry for, most recently changed first. */
export function useHistorySessions(count: number | null, enabled: boolean) {
  const [sessions, setSessions] = useState<SessionChoice[]>([])
  useEffect(() => {
    if (!enabled || count == null) return
    let live = true
    fetch("/api/history/sessions")
      .then(res => res.json())
      .then(list => live && setSessions(list))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [count, enabled])
  return sessions
}

/** What the monitor found on this machine; fetched when the tab opens. */
export function useSetup(enabled: boolean) {
  const [state, setState] = useState<{ report: SetupReport | null; failed: boolean }>({ report: null, failed: false })
  useEffect(() => {
    if (!enabled) return
    let live = true
    fetch("/api/setup")
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(report => live && setState({ report, failed: false }))
      .catch(() => live && setState(s => ({ ...s, failed: true })))
    return () => {
      live = false
    }
  }, [enabled])
  return state
}

const onHashChange = (notify: () => void) => {
  window.addEventListener("hashchange", notify)
  return () => window.removeEventListener("hashchange", notify)
}

/** The URL hash as React state, so the open tab survives a reload or a bookmark. */
export function useHash(): [string, (hash: string) => void] {
  const hash = useSyncExternalStore(onHashChange, () => window.location.hash, () => "")
  const setHash = (next: string) => {
    window.history.replaceState(null, "", next ? `#${next}` : window.location.pathname + window.location.search)
    window.dispatchEvent(new HashChangeEvent("hashchange"))
  }
  return [hash, setHash]
}

/** Figures for the stats tab; refreshed every minute while the tab is open. */
export function useStats(days: number, session: string | null, split: string | null, enabled: boolean) {
  const key = `${days}|${session ?? ""}|${split ?? ""}`
  const [state, setState] = useState<{ key: string; stats: Stats | null; failed: boolean }>({ key, stats: null, failed: false })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = () =>
      fetch(`/api/stats?days=${days}&${sessionQuery(session)}${split ? `&split=${split}` : ""}`)
        .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then(stats => live && setState({ key, stats, failed: false }))
        .catch(() => live && setState(s => ({ ...s, failed: true })))
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [days, session, split, key, enabled])
  // Figures for another range or session are not shown as if they were for this one.
  return { stats: state.key === key ? state.stats : null, failed: state.failed }
}

/** Days on which an OpenCode config file changed, newest first. Empty until loaded, or when none. */
export function useConfigChanges(days: number, enabled: boolean) {
  const [changes, setChanges] = useState<ConfigChange[]>([])
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = () =>
      fetch(`/api/config-changes?days=${days}`)
        .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then(list => live && Array.isArray(list) && setChanges(list))
        .catch(() => {})
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [days, enabled])
  return changes
}
