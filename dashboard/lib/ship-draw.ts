// Draws the bridge, one pixel at a time. The crew, the consoles and the ship are this
// project's own: drawn here as text, from no asset pack and after no one else's characters.
import { STATION_H, STATION_W, HULL_TOP, type Screen } from "./ship"

/** A fixed palette: the bridge looks the same in the light and the dark theme. */
const C = {
  space: "#070a18", star: "#dfe6ff", starDim: "#5b6488", planet: "#4b5fd6", planetLit: "#7f93ff",
  hull: "#151b31", hullLine: "#1d2541", plate: "#1a2138", plateLine: "#232c4a", frame: "#2c3557", frameLit: "#46527e",
  outline: "#0d1022", screen: "#0b1020", off: "#141826",
  green: "#5ce07a", amber: "#ffc04d", orange: "#ff8a3d", red: "#ff5a6e", blue: "#6fc3ff", white: "#e9edff", grey: "#7a829c",
  pink: "#ff7ab6", yellow: "#ffd166", mint: "#9be7c4", darkRed: "#5a2230",
}
const HAIR = ["#3b2a20", "#e2b04a", "#1f1f2e", "#a24a2c", "#6b4a7a", "#cfd6e8"]
const SKIN = ["#f1c9a5", "#d9a07a", "#a8704d", "#f6d7bd", "#c58c63", "#8c5a3c"]
const SUIT = ["#3d7be0", "#d0583a", "#2fae7c", "#9b6be0", "#d6a33a", "#5a6a8c"]

// Faces the viewer, behind a console. k outline, h hair, s skin, c suit, b badge.
const CREW = [
  "..kkkkkk..",
  ".khhhhhhk.",
  "khhhhhhhhk",
  "khsssssshk",
  "kssksskssk",
  "kssssssssk",
  ".kssssssk.",
  "...kssk...",
  ".kccbccck.",
  "kcccccccck",
  "kcccccccck",
  "ksccccccsk",
]
const TYPING: Record<number, string> = { 10: "ksccccccsk", 11: "kcccccccck" }
const DRONE = [".kkk.", "kbwbk", "kwwwk", ".kkk.", "k...k"]
const ZED = ["www", "..w", ".w.", "www"]

export interface Station {
  x: number
  y: number
  screen: Screen
  state: string
  look: { hair: number; skin: number; suit: number }
  fuel: { fill: number | null; tick: number | null; high: boolean }
  drones: number
  selected: boolean
  /** When it was last compacted, for the burst of exhaust. */
  compactedAt: number | null
}

export interface Scene {
  width: number
  height: number
  stations: Station[]
  mcp: ("ok" | "failed" | "unknown")[]
  frame: number
  now: number
  still: boolean
}

type Pal = Record<string, string>

/** Where the stars are, as fractions of the window: scattered, the same every time. */
const STARS = Array.from({ length: 46 }, (_, i) => {
  const r = (n: number) => (((Math.sin(n * 12.9898) * 43758.5453) % 1) + 1) % 1
  return { x: r(i + 1), y: r(i + 101) }
})

/** The colour of a station's beacon: its state, readable from across the room. */
const BEACON: Record<string, string> = { waiting: C.amber, stuck: C.orange, error: C.red, working: C.blue, finished: C.green }
const MCP_LIGHT = { ok: C.green, failed: C.red, unknown: C.grey } as const

/** What every drawing step uses: the context, the frame (0 when still), and two ways to put pixels down. */
interface Pen {
  g: CanvasRenderingContext2D
  f: number
  still: boolean
  px: (x: number, y: number, c: string, w?: number, h?: number) => void
  sprite: (rows: string[], x: number, y: number, pal: Pal) => void
}

function penFor(g: CanvasRenderingContext2D, scene: Scene): Pen {
  const px = (x: number, y: number, c: string, w = 1, h = 1) => {
    g.fillStyle = c
    g.fillRect(Math.round(x), Math.round(y), w, h)
  }
  const sprite = (rows: string[], x: number, y: number, pal: Pal) => {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] !== ".") px(x + i, y + j, pal[row[i]] ?? C.outline)
    })
  }
  return { g, px, sprite, still: scene.still, f: scene.still ? 0 : scene.frame }
}

export function drawShip(g: CanvasRenderingContext2D, scene: Scene) {
  const pen = penFor(g, scene)
  viewport(pen, scene.width)
  mcpPanel(pen, scene)
  deck(pen, scene)
  for (const s of scene.stations) station(pen, s, scene.now)
}

/** The window along the top: stars drifting past, a planet, the frame around it. */
function viewport({ g, px, f }: Pen, width: number) {
  px(0, 0, C.space, width, HULL_TOP)
  for (const [i, star] of STARS.entries()) {
    const speed = (i % 3) + 1
    const x = (((star.x * width - f * speed) % width) + width) % width
    px(x, 4 + star.y * (HULL_TOP - 12), speed === 3 ? C.star : C.starDim)
  }
  const planetX = Math.round(width * 0.72) - ((f / 6) % 40)
  g.fillStyle = C.planet
  g.beginPath()
  g.arc(planetX, 30, 11, 0, Math.PI * 2)
  g.fill()
  px(planetX - 7, 24, C.planetLit, 4, 2)
  px(0, 0, C.frame, width, 3)
  for (let x = 0; x < width; x += 64) px(x, 0, C.frame, 3, HULL_TOP)
  px(0, HULL_TOP - 4, C.frame, width, 4)
  px(0, HULL_TOP - 4, C.frameLit, width, 1)
}

/** One light per MCP server, as on the environment strip: green works, grey no signal, red failed. */
function mcpPanel({ px, f }: Pen, scene: Scene) {
  if (!scene.mcp.length) return
  const lights = scene.mcp.slice(0, 10)
  const w = lights.length * 5 + 5
  const x0 = scene.width - w - 6
  px(x0, 6, C.outline, w, 11)
  px(x0 + 1, 7, C.hull, w - 2, 9)
  const dark = Math.floor(f / 4) % 2 === 1
  lights.forEach((m, i) => px(x0 + 4 + i * 5, 10, m === "failed" && dark ? C.darkRed : MCP_LIGHT[m], 2, 3))
}

function deck({ px }: Pen, scene: Scene) {
  px(0, HULL_TOP, C.hull, scene.width, scene.height - HULL_TOP)
  for (let y = HULL_TOP + 14; y < scene.height; y += 16) px(0, y, C.hullLine, scene.width, 1)
  for (let x = 8; x < scene.width; x += 32) px(x, HULL_TOP, C.hullLine, 1, scene.height - HULL_TOP)
}

function station(pen: Pen, s: Station, now: number) {
  const { x, y } = s
  const pal: Pal = { k: C.outline, h: HAIR[s.look.hair], s: SKIN[s.look.skin], c: SUIT[s.look.suit], b: C.yellow, w: C.white }
  pen.px(x + 6, y + 44, C.plate, STATION_W - 12, 10)
  pen.px(x + 6, y + 44, C.plateLine, STATION_W - 12, 1)
  beacon(pen, s)
  pen.px(x + 28, y + 16, C.outline, 18, 16)
  pen.px(x + 29, y + 17, C.frame, 16, 14)
  crew(pen, s, pal, x + 32, y + 14)
  consoleDesk(pen, s)
  screen(pen, s, x + 52, y + 14)
  gauge(pen, s, now)
  drones(pen, s)
  if (!s.selected) return
  pen.g.strokeStyle = C.white
  pen.g.lineWidth = 1
  pen.g.setLineDash([2, 2])
  pen.g.strokeRect(x + 8.5, y + 0.5, STATION_W - 17, STATION_H - 7)
  pen.g.setLineDash([])
}

/** Centred over the station, where its bubble is: a bubble covers it, and without one it shows. */
function beacon({ px, f }: Pen, s: Station) {
  const pulse = (s.state === "waiting" || s.state === "error") && Math.floor(f / 3) % 2 === 1
  const bx = s.x + STATION_W / 2 - 3
  px(bx, s.y + 2, C.outline, 6, 4)
  px(bx + 1, s.y + 3, pulse ? C.outline : (BEACON[s.state] ?? C.grey), 4, 2)
}

/** The crew member, in the pose of the session's state. */
function crew(pen: Pen, s: Station, pal: Pal, cx: number, cy: number) {
  const { px, sprite, f } = pen
  if (s.state === "idle") {
    // asleep, head down on the console
    sprite(CREW.slice(8), cx, cy + 8, pal)
    sprite(CREW.slice(0, 8).map((r, j) => (j === 4 ? "kssssssssk" : r)), cx, cy + 5, pal)
    sprite(ZED, cx + 12, cy - 2 - Math.floor((f % 12) / 3), pal)
    return
  }
  const slow = s.screen === "think" || s.screen === "compact"
  const typing = s.state === "working" && Math.floor(f / (slow ? 4 : 2)) % 2 === 1
  sprite(typing ? CREW.map((r, j) => TYPING[j] ?? r) : CREW, cx, cy, pal)
  if (s.state === "waiting") {
    // one hand up, waving
    px(cx + 10, cy + 3, pal.c, 1, 7)
    px(cx + 10 + (Math.floor(f / 3) % 2), cy + 1, pal.s, 1, 2)
  } else if (s.state === "finished") {
    // both arms up
    for (const ax of [cx - 1, cx + 10]) {
      px(ax, cy + 4, pal.c, 1, 6)
      px(ax, cy + 3, pal.s)
    }
  } else if (s.state === "stuck") {
    px(cx + 9, cy + 2 + (f % 6), C.blue, 1, 2)
  }
}

/** The slanted desk, with a row of lights that run while the session does. */
function consoleDesk({ px, f, still }: Pen, s: Station) {
  const { x, y } = s
  px(x + 14, y + 28, C.frameLit, 46, 2)
  px(x + 14, y + 30, C.frame, 46, 10)
  px(x + 14, y + 40, C.outline, 46, 1)
  const colours = [C.green, C.blue, C.amber]
  for (let i = 0; i < 6; i++) {
    const lit = s.state !== "idle" && (still ? i % 2 === 0 : (f + i * 3) % 7 < 4)
    px(x + 18 + i * 6, y + 34, lit ? colours[i % 3] : C.hullLine, 3, 2)
  }
}

/** The fuel gauge is the context, with a tick where OpenCode compacts, and a puff when it has. */
function gauge({ px, f, still }: Pen, s: Station, now: number) {
  const gx = s.x + 66
  const gy = s.y + 14
  const gh = 24
  px(gx, gy, C.outline, 6, gh + 2)
  px(gx + 1, gy + 1, C.screen, 4, gh)
  if (s.fuel.fill == null) {
    // not known: a slow blink, not an empty tank
    if (still || Math.floor(f / 4) % 2 === 0) px(gx + 2, gy + gh / 2, C.grey, 2, 2)
  } else {
    const h = Math.max(1, Math.round(s.fuel.fill * gh))
    px(gx + 1, gy + 1 + gh - h, s.fuel.high ? C.amber : C.mint, 4, h)
  }
  if (s.fuel.tick != null) px(gx - 1, gy + 1 + gh - Math.round(s.fuel.tick * gh), C.white, 8, 1)
  const k = s.compactedAt == null || still ? -1 : (now - s.compactedAt) / 3000
  if (k < 0 || k >= 1) return
  for (let i = 0; i < 6; i++) px(gx + 7 + Math.round(k * 14) + (i % 3) * 2, gy + 4 + i * 3 - Math.round(k * 6), C.white, 1, 1)
}

/** Subagents at work, as drones that hover beside the station. */
function drones({ px, sprite, f, still }: Pen, s: Station) {
  for (let i = 0; i < Math.min(2, s.drones); i++) {
    const bob = still ? 0 : Math.floor((f + i * 3) / 3) % 2
    sprite(DRONE, s.x + 78 + i * 8, s.y + 16 + i * 9 + bob, { k: C.outline, b: C.blue, w: C.white })
    if (!still && f % 4 < 2) px(s.x + 80 + i * 8, s.y + 21 + i * 9 + bob, C.amber, 1, 1)
  }
}

// What each screen shows. A state comes first; while working, the tool.
const ICONS: Partial<Record<Screen, { rows: string[]; dx: number; dy: number; pal?: Pal }>> = {
  ask: { rows: [".oo.", "o..o", "..o.", "....", "..o."], dx: 3, dy: 1 },
  wait: { rows: ["wwww", ".ww.", "..w.", ".ww.", "wwww"], dx: 3, dy: 1 },
  fail: { rows: ["r..r", ".rr.", ".rr.", "r..r"], dx: 3, dy: 2 },
  done: { rows: [".....g", "....g.", "g..g..", ".gg..."], dx: 2, dy: 2 },
  web: { rows: [".bbbb.", "bbwbbb", "bwwbbb", "bbbwwb", ".bbbb."], dx: 2, dy: 1 },
  task: { rows: [".kkk.", "kbwbk", "kwwwk", ".kkk."], dx: 2, dy: 2, pal: { k: C.grey, b: C.blue, w: C.white } },
}
const SCREEN_PAL: Pal = { o: C.amber, w: C.white, r: C.red, g: C.green, b: C.blue }

/** Screens that move: lines of output, of code, a page, the dots of thinking. */
const MOVING: Partial<Record<Screen, (pen: Pen, sx: number, sy: number) => void>> = {
  shell: ({ px, f }, sx, sy) => {
    for (let i = 0; i < 3; i++) px(sx + 1, sy + 1 + i * 2, C.green, 2 + ((i * 5 + f) % 7), 1)
  },
  code: ({ px, f }, sx, sy) => {
    const colours = [C.pink, C.blue, C.yellow]
    for (let i = 0; i < 3; i++) px(sx + 1 + (i % 2) * 2, sy + 1 + i * 2, colours[(i + f) % 3], 4 + (i % 2) * 2, 1)
  },
  read: ({ px }, sx, sy) => {
    px(sx + 1, sy, C.white, 8, 8)
    for (let i = 0; i < 3; i++) px(sx + 2, sy + 2 + i * 2, C.grey, i === 2 ? 4 : 6, 1)
  },
  compact: ({ px, f }, sx, sy) => {
    for (let i = 0; i < 3; i++) px(sx + 1 + i * 3, sy + 3 + ((f + i) % 3), C.white, 2, 2)
  },
  think: ({ px, f }, sx, sy) => {
    for (let i = 0; i < 3; i++) px(sx + 2 + i * 3, sy + 4, Math.floor(f / 2) % 3 === i ? C.white : C.grey, 2, 2)
  },
}

function screen(pen: Pen, s: Station, x: number, y: number) {
  const { px, sprite } = pen
  px(x, y, C.outline, 12, 10)
  px(x + 5, y + 10, C.outline, 2, 4)
  const sx = x + 1
  const sy = y + 1
  px(sx, sy, s.screen === "off" ? C.off : C.screen, 10, 8)
  const icon = ICONS[s.screen]
  if (icon) sprite(icon.rows, sx + icon.dx, sy + icon.dy, icon.pal ?? SCREEN_PAL)
  else MOVING[s.screen]?.(pen, sx, sy)
}
