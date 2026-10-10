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

`npm audit --omit=dev` must stay clean; CI checks it. `npm audit` without it also reports the
development tools (the shadcn CLI, ESLint). Do not run `npm audit fix --force` for those: when
no fixed release exists it "fixes" by moving a tool back to an old major version.

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

The rhythm of the page is defined once, in `components/monitor/section.tsx`: the space between
the blocks of a tab (`TAB`), the chapter heading and the rule above it (`Chapter`), the heading
inside a chapter (`H3`) and the 12px under it (`SUB`), a two-column grid of sections (`GRID`), a few labelled figures side by side (`Facts`, values aligned even when a label wraps), and table head cells (`TH`). A new tab or section uses these instead of
its own sizes; that is what keeps the four tabs alike. Before a release, look at every tab at
360px wide in both languages: the page must not scroll sideways. A new string needs a key of its own: CI fails when a key is defined twice in i18n/*.json, which would silently replace an older string.

Colours for each agent state are tokens in `app/globals.css` (`--waiting`, `--stuck`, ...), with
separate light and dark values.
