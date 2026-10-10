import type { Metadata } from "next"
import { IBM_Plex_Mono, Prompt } from "next/font/google"
import { Providers } from "@/components/providers"
import "./globals.css"

// Fonts are downloaded at build time and shipped with the page: the monitor never
// contacts a font service while it runs.
// Prompt: one family for Thai and Latin, so mixed lines share one rhythm. Only the weights
// the type scale uses (globals.css) are shipped.
const prompt = Prompt({ variable: "--font-prompt", subsets: ["thai", "latin"], weight: ["300", "400", "500", "600"], display: "swap" })
// Commands and paths keep a fixed-width face, so columns of them line up; Thai inside them
// falls back to Prompt.
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" })

export const metadata: Metadata = {
  title: "OpenCode Monitor",
  description: "Is your OpenCode agent working, waiting for you, stuck, finished, or failed?",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${prompt.variable} ${plexMono.variable} antialiased`}>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
