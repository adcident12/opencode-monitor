import type { NextConfig } from "next"
import { PHASE_DEVELOPMENT_SERVER } from "next/constants"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// The page is built once into static files that the monitor server (../server.mjs) serves,
// so people who only run the monitor never need npm. During `npm run dev`, requests for
// live data are passed on to a monitor running on its default port.
const MONITOR = process.env.MONITOR_URL ?? "http://127.0.0.1:4317"

// The repository root, so the shared ../i18n strings can be imported.
const root = fileURLToPath(new URL("..", import.meta.url))

// Written by scripts/build-id.mjs just before `next build`, baked into the page, and copied
// to public/build.json by scripts/publish.mjs. The monitor reports the id of the page it
// serves, so a page left open across an update can tell it is out of date.
const buildIdFile = fileURLToPath(new URL(".build-id", import.meta.url))
const buildId = existsSync(buildIdFile) ? readFileSync(buildIdFile, "utf8").trim() : "dev"

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      env: { NEXT_PUBLIC_BUILD_ID: "dev" },
      turbopack: { root },
      async rewrites() {
        return [
          { source: "/api/:path*", destination: `${MONITOR}/api/:path*` },
          { source: "/i18n/:path*", destination: `${MONITOR}/i18n/:path*` },
        ]
      },
    }
  }
  return {
    env: { NEXT_PUBLIC_BUILD_ID: buildId },
    turbopack: { root },
    output: "export",
    images: { unoptimized: true },
    poweredByHeader: false,
  }
}
