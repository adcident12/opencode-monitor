"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import type { HistoryEvent, Snapshot, Stats } from "./types"

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

/** History list, re-fetched only when the server says its count changed. */
export function useHistory(count: number | null, enabled: boolean) {
  const [events, setEvents] = useState<HistoryEvent[]>([])
  useEffect(() => {
    if (!enabled || count == null) return
    let live = true
    fetch("/api/history")
      .then(res => res.json())
      .then(list => live && setEvents(list))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [count, enabled])
  return events
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
export function useStats(days: number, enabled: boolean) {
  const [state, setState] = useState<{ days: number; stats: Stats | null; failed: boolean }>({ days, stats: null, failed: false })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = () =>
      fetch(`/api/stats?days=${days}`)
        .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then(stats => live && setState({ days, stats, failed: false }))
        .catch(() => live && setState(s => ({ ...s, failed: true })))
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [days, enabled])
  // Figures for another range are not shown as if they were for this one.
  return { stats: state.days === days ? state.stats : null, failed: state.failed }
}
