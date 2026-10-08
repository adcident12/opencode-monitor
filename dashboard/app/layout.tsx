import type { Metadata } from "next"
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Thai } from "next/font/google"
import { Providers } from "@/components/providers"
import "./globals.css"

// Fonts are downloaded at build time and shipped with the page: the monitor never
// contacts a font service while it runs.
const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["300", "400", "500", "600"] })
const plexThai = IBM_Plex_Sans_Thai({ variable: "--font-plex-thai", subsets: ["thai"], weight: ["300", "400", "500", "600"] })
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] })

export const metadata: Metadata = {
  title: "OpenCode Monitor",
  description: "Is your OpenCode agent working, waiting for you, stuck, finished, or failed?",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${plexSans.variable} ${plexThai.variable} ${plexMono.variable} antialiased`}>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
