// The mark: an open ring and a dot. The ring is a dial left open, for the thing this tool
// measures (how long a session has been waiting); the dot is the session, and its colour is
// the state of your sessions.
//
// It is this project's own mark. It deliberately shares no shape with OpenCode's logo (a
// rectangular frame with a shaded lower half): that logo belongs to its owners and is not
// used, copied or adapted here.

export type MarkTone = "waiting" | "stuck" | "error" | "working" | "quiet"

/** Fixed colours for the browser tab, where the page's CSS variables do not reach. */
export const TAB_COLOURS: Record<MarkTone, string> = {
  waiting: "#f2b33d",
  stuck: "#f08a4b",
  error: "#ef6b73",
  working: "#7fb0ff",
  quiet: "#8b93a7",
}

/** Geometry of the ring, shared by the tab icon and the logo on the page. */
export const RING = {
  cx: 16,
  cy: 16,
  r: 9.5,
  strokeWidth: 3.4,
  // Three quarters of the circumference drawn, one quarter open.
  dash: "44.77 14.92",
  rotate: "rotate(-45 16 16)",
} as const

/**
 * The mark as SVG, on its own dark tile so it reads on a light or a dark tab bar.
 * @param dot  colour of the dot
 */
export function markSvg(dot: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="7" fill="#161b26"/>',
    `<circle cx="${RING.cx}" cy="${RING.cy}" r="${RING.r}" fill="none" stroke="#e9ecf3" stroke-width="${RING.strokeWidth}" stroke-linecap="round" stroke-dasharray="${RING.dash}" transform="${RING.rotate}"/>`,
    `<circle cx="16" cy="16" r="4.2" fill="${dot}"/>`,
    "</svg>",
  ].join("")
}

export const markDataUrl = (tone: MarkTone) => `data:image/svg+xml,${encodeURIComponent(markSvg(TAB_COLOURS[tone]))}`
