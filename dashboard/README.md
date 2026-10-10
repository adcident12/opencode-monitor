# dashboard

The page the monitor shows, built with Next.js, Tailwind CSS, and shadcn/ui (Base UI).

You only need this folder to change the page. Running the monitor does not: the built page is
committed in `../public`, which `../server.mjs` serves.

## Work on it

Start the monitor first (it supplies the live data), then the dev server:

```sh
# terminal 1, repository root
node server.mjs --sample

# terminal 2
cd dashboard
npm install
npm run dev
```

Open <http://localhost:3000>. Requests to `/api/*` and `/i18n/*` are passed on to the monitor
at `http://127.0.0.1:4317`; set `MONITOR_URL` to use another address.

## Before committing

```sh
npm run lint
npm run typecheck
npm test
npm run build   # exports to out/ and copies it to ../public
```

Commit the changes in `../public` together with the source changes.

## Where things are

```
app/page.tsx                 the page: groups sessions by how urgently they need you
components/monitor/          header, environment line, session cards, history
components/ui/               shadcn/ui components (add more with `npx shadcn add <name>`)
lib/types.ts                 shape of the data the monitor sends
lib/live.ts                  server-sent events, the ticking clock, the URL hash
lib/i18n.tsx                 strings from ../i18n/<lang>.json (English is bundled)
```

Type is one family, Prompt (Thai and Latin), with IBM Plex Mono for commands and paths. The
sizes are a fixed scale defined at the top of `app/globals.css` (`text-2xs` to `text-3xl`, plus
`text-code` for monospaced text); use those names, not arbitrary values like `text-[0.82rem]`.
Line heights are loose on purpose, so Thai tone marks are not clipped.

Colours for each agent state are tokens in `app/globals.css` (`--waiting`, `--stuck`, ...), with
separate light and dark values.
