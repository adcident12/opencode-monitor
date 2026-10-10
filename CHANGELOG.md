# Changelog

What each version added, newest first. The version that is running is shown next to the title
on the page and printed at startup.

## 10.0.0 - 2026-10-10

From figures to what to do about them.

- **Worth knowing**: above the figures in Stats, up to five sentences say what they add up to:
  replies cut off at the output limit, MCP servers switched on and never called, a permission
  asked again and again, where most of the agent's time goes, and more. Each is a fixed rule
  over figures the page already shows, with a minimum of evidence; nothing is guessed, and
  when no rule holds the box is not there.
- **When OpenCode's settings changed**: the monitor notices a save of `opencode.json` that
  changed a setting, global or a project's, lists it in Stats with what changed, and compares
  the days before with the days from it on at a click. A change made while the monitor was
  off is found at the next start. Secrets are never read; addresses and commands are kept
  only as "changed".
- **Ask Claude about it**: `mcp.mjs` gives the same figures to Claude Code or any MCP client
  (`claude mcp add opencode-monitor -- node /path/to/mcp.mjs`). Five tools, all read-only; it
  reads OpenCode's data itself, so the monitor does not have to be running, and it writes
  nothing. The README says what reaches the assistant once you connect it.
- **Weekly summary**: with `notify.weekly.enabled`, the week in a line and its takeaways go
  to your Discord webhook once a week. Off by default; never sent late or twice.
  `--test-notify` sends it too, and This machine and `--doctor` say when it goes out.
- Fixed: a config with a comment after a trailing comma could not be read, so its limits and
  MCP servers were ignored.
- After a SonarQube scan: system programs are run by their full path on Windows and macOS,
  six regular expressions that could be slow on long input now read it once, and the monitor
  can be stopped cleanly from code. Tests cover 87% of the lines.

## 9.0.0 - 2026-10-10

The whole of the agent's work, not only its tool calls, and figures you can check.

- **Where the time went**: the agent's time split into reading the prompt, thinking, writing,
  and tools running, with which of them takes most and what would shorten it.
- **Your prompts**: steps and time per prompt, and how each ended: answered, continued by your
  next prompt, cut off at the output limit, stopped by you, failed, or left without an answer.
- **What interrupted you**: the permission prompts asked most often, with an example rule.
- **What got done**, a new chapter: the files changed most often, and the agent's plans followed
  through every list it wrote. OpenCode keeps only a session's latest list, so a replaced plan
  used to vanish; items that left a plan without being marked done are now counted.
- **Agents**: time, replies, tokens and cost per agent, and which ran only as subagents.
- **`npm run verify`**: recomputes the page's figures from your own data, independently, and
  reports any that differ. On the author's machine, 143 of 143 agree.
- Fixed before release: a new string had replaced the "files touched" line on session cards;
  plans for a short period counted a list written before it. A test now fails when a string
  key is defined twice.
- Sections and labelled figures share one spacing, and figures stay on one line when a label
  wraps; the title of a finished session is no longer squeezed on a phone.

## 8.1.0 - 2026-10-10

Notifications you can check, and one rhythm for every tab.

- **Fixed:** with four tabs the tab bar was wider than a 360px screen, so the whole page
  scrolled sideways on a phone (since 8.0.0).
- Every notification is kept with how each channel answered, shown on the This machine tab
  and printed as it is sent. A refused message is warned about instead of vanishing.
- `--test-notify` sends one sample of every kind in `notify.on` through the same code as the
  real ones, so "stuck" and "about to be compacted" are tested, not only the channel.
- "About to be compacted" is announced once per compaction. It could be sent twice when the
  estimate of requests left moved out of the warning and back.
- All four tabs share one definition of spacing, chapter headings and table heads; History
  gains its two chapters, and tables end flush with the right edge.

## 8.0.0 - 2026-10-10

Made to work well on a machine that is not the author's.

- **This machine**, a new tab, and `--doctor` in the terminal: what the monitor read from
  where it runs (OpenCode's database, log and config; the models in use with their limits and
  the size at which each is compacted; notification channels) and, first, what is missing and
  what to change. A model with no limit set anywhere is named instead of silently showing no
  context bar.
- The monitor has **its own mark**: an open ring and a dot, as favicon, touch icon and logo.
  The dot takes the colour of the most urgent session, in the header and in the browser tab.
  The project is independent of OpenCode and does not use its logo.
- **`--autostart` on macOS** (launchd) **and Linux** (systemd user unit), beside Windows. CI
  turns it on and off for real on all three systems.
- **Cost**, for paid models: per day, per session, and in the before-and-after comparison,
  shown only when something was spent.
- A warning when OpenCode is a later minor or major release than the one the monitor was
  checked against.
- The line about graft is shown only to people who have graft.

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
