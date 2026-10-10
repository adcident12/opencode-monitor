# Changelog

What each version added, newest first. The version that is running is shown next to the title
on the page and printed at startup.

## 7.0.0 - 2026-10-10

Compaction, seen before it happens, and history you can page through.

- **Before a session is compacted**: the session card marks on the context bar where OpenCode
  will compact, and says how many tokens and roughly how many requests are left. The point is
  worked out with OpenCode's own rule from the limits in each user's `opencode.json` (the
  project's file over the global one), including `limit.input`, `compaction.reserved`,
  `compaction.auto` and `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`. Checked against 237 real
  compactions: all 237 happened on the first request at or over the predicted point.
- While a session is being compacted the card says so instead of showing the old size, and a
  compaction forced by the model server refusing a request is named as a mismatch between the
  server's context size and `limit.context`.
- `notify.on` can include `"compact_soon"` for one desktop or Discord message per compaction.
- **History is paged**: the newest 100 entries, then "Load older entries". It used to show only
  the newest 300 without saying so. Both filters now cover the whole record.
- **What each session took**, above the history: agent time, time waiting for you, compactions
  and tokens per session over 30 days; click one to follow it.
- **CSV**: the figures per day and the per-session table can be downloaded.
- Stats lists up to 50 re-read files, ten until asked for the rest; the context chart of a
  session draws its compaction point.
- CI fails on a known vulnerability in what the page ships.

## 6.1.0 - 2026-10-10

The page, tidied. Nothing it shows or does has changed.

- Type is one family, **Prompt**, for Thai and Latin, on a fixed size scale with line heights
  loose enough for Thai tone marks. Commands and paths stay in IBM Plex Mono.
- **Stats** is split into four chapters (waiting for you, the agent's work, the model, MCP
  servers) with links to jump between them.
- Columns line up: ranked rows, the environment strip, and session health.
- On a phone nothing scrolls sideways any more, and dates move under labels instead of
  overlapping them.
- State colours in light mode reach 4.5:1 contrast for small text.
- MCP servers that are off with nothing to report are named in one line instead of rows of
  zeros.

## 6.0.0 - 2026-10-10

Measuring whether a change to your setup helped.

- **Model speed** in Stats, per model: tokens per second while writing and while reading a new
  prompt, the typical wait for the first token, and writing speed per day. Tool run time and
  time spent waiting for you are not counted.
- **Before and after**: pick the day you changed a setting and the days on either side are set
  next to each other, as rates and typical values, each labelled better or worse.
- **Context of one session**: the size of each request against the context window, every
  compaction marked, and how many already-read files were read again after each one.
- **`--autostart on|off`** (Windows): start the monitor at login through a scheduled task for
  your user, without a console window.
- The version is shown on the page and at startup, and `--version` prints it.

## 5.0.0 - 2026-10-10

MCP servers, and looking at one session at a time.

- **MCP servers** in Stats, one row each: calls, time per call, last use, dropped connections,
  failed starts, most used tools. Servers switched on but never called are named.
- MCP status is more accurate: servers from a project's own `opencode.json` are known, a tool
  reporting an error is kept apart from the server not answering, connections closed because
  OpenCode quit are not failures, and a tool call that finds the connection gone marks the
  server failed.
- **Stats and History can be narrowed to one session**, and each session card links to its own
  (`#stats/<session id>`).
- **Tokens** in Stats: sent to the model, the share reused from its cache, written by the
  model, cost when recorded, and how big a session is at its first request.
- Which OpenCode is still running is read off the log, so a one-off command no longer hides
  what the open window logged, and two windows are both followed.

## 4.0.0 - 2026-10-08

- The page was rebuilt with Next.js, Tailwind CSS, and shadcn/ui.
- **Stats** tab: waiting time, hung calls, and tool use over 7 to 30 days.
- **Still running**: background processes a session started that are still alive.
- An open page says when the monitor behind it has been updated.
- `--test-notify` to check desktop and Discord notifications.

## 3.0.0 - 2026-10-08

The first versions, up to the `v3` branch.

- The status page itself: working, waiting for you, probably stuck, finished, or failed, read
  from OpenCode's database and log without changing anything.
- Session health, the environment strip (model server, MCP servers, services), history,
  desktop and Discord notifications, and redaction of secrets.
- **Work** and **To review** on each session, with the git probe reduced to reading
  `.git/HEAD` and never running git.
- Tests on Windows, Linux, and macOS in CI.
