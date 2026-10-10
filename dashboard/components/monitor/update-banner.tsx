"use client"

import { RefreshCwIcon } from "lucide-react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"

// The id this page was built with. "dev" under `npm run dev`, where it is never compared.
const OWN_BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev"

/**
 * The monitor is a page people leave open for days. Its live data keeps arriving after an
 * update, so nothing looks wrong, but the page itself stays old. The server says which build
 * it serves; when that differs from this page's, offer a reload.
 */
export function UpdateBanner({ served }: Readonly<{ served: string | null }>) {
  const { t } = useI18n()
  if (OWN_BUILD === "dev" || !served || served === OWN_BUILD) return null
  return (
    <Alert className="border-working/40 bg-working-soft/60 pr-32">
      <RefreshCwIcon className="text-working" aria-hidden />
      <AlertTitle>{t("update.title")}</AlertTitle>
      <AlertDescription>{t("update.body")}</AlertDescription>
      <AlertAction className="top-1/2 -translate-y-1/2">
        <Button size="sm" onClick={() => window.location.reload()}>
          {t("update.reload")}
        </Button>
      </AlertAction>
    </Alert>
  )
}
