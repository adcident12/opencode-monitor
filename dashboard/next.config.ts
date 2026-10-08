import type { NextConfig } from "next"
import { PHASE_DEVELOPMENT_SERVER } from "next/constants"
import { fileURLToPath } from "node:url"

// The page is built once into static files that the monitor server (../server.mjs) serves,
// so people who only run the monitor never need npm. During `npm run dev`, requests for
// live data are passed on to a monitor running on its default port.
const MONITOR = process.env.MONITOR_URL ?? "http://127.0.0.1:4317"

// The repository root, so the shared ../i18n strings can be imported.
const root = fileURLToPath(new URL("..", import.meta.url))

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
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
    turbopack: { root },
    output: "export",
    images: { unoptimized: true },
    // No "Powered by" header, no telemetry-style extras; the output is plain files.
    poweredByHeader: false,
  }
}
