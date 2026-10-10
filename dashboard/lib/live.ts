"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import type { HistoryEvent, SessionChoice, Snapshot, Stats } from "./types"

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

/** History list, re-fetched only when the server says its count changed, or the filter did. */
export function useHistory(count: number | null, enabled: boolean, session: string | null = null) {
  const [state, setState] = useState<{ session: string | null; events: HistoryEvent[] }>({ session, events: [] })
  useEffect(() => {
    if (!enabled || count == null) return
    let live = true
    fetch(`/api/history?${sessionQuery(session)}`)
      .then(res => res.json())
      .then(events => live && setState({ session, events }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [count, enabled, session])
  // Entries of another session are not shown as if they were this one's.
  return state.session === session ? state.events : []
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
