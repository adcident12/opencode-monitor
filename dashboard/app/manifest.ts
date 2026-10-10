import type { MetadataRoute } from "next"

// Written once at build time, like the rest of the page.
export const dynamic = "force-static"

/**
 * What a browser needs to install the monitor as an app: its own window, its own icon. The
 * app is still this page from the monitor on this machine, so the monitor must be running.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "OpenCode Monitor",
    short_name: "OC Monitor",
    description: "Is your OpenCode agent working, waiting for you, stuck, finished, or failed?",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#161b26",
    theme_color: "#161b26",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
