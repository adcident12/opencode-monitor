"use client"

import { MonitorDownIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { Hint } from "./hint"

/** The browser's offer to install the page as an app (Chrome and Edge make it; others do not). */
type InstallOffer = Event & { prompt: () => Promise<unknown> }

/**
 * Installs the monitor as an app: its own window and icon, instead of a browser tab. Shown
 * only while the browser offers it, so never where it cannot be done, nor once installed.
 */
export function InstallButton() {
  const { t } = useI18n()
  const [offer, setOffer] = useState<InstallOffer | null>(null)
  useEffect(() => {
    const onOffer = (e: Event) => {
      // Kept for our own button, in place of the browser's banner.
      e.preventDefault()
      setOffer(e as InstallOffer)
    }
    const onInstalled = () => setOffer(null)
    window.addEventListener("beforeinstallprompt", onOffer)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])
  if (!offer) return null
  const install = async () => {
    // An offer can be used once, whatever the answer.
    setOffer(null)
    await offer.prompt().catch(() => {})
  }
  return (
    <Hint label={t("app.install.hint")} render={<Button variant="outline" size="sm" onClick={install} />}>
      <MonitorDownIcon aria-hidden />
      {t("app.install")}
    </Hint>
  )
}
