# Changelog

What each version added, newest first. The version that is running is shown next to the title
on the page and printed at startup.

## 11.2.0 - 2026-10-11

The whole bridge played back, the monitor as an app, and on your own network.

- **The whole bridge**, in the Replay tab: every session of one day at once, a station a
  session, how many were in each state, a line for each saying what it was doing, and a
  timeline with a row a session. Each session is its own replay by the same rules; a
  station leads to it. Checked on real data: 13 days, 9,331 station-moments, no difference.
- **The player holds still.** The running time is a stopwatch of one width, the play
  button keeps one width, and every panel has its height from the start, so nothing moves
  while it plays: checked on every session of real data, 160 places each.
- **Seven speeds**, 1x (real speed), 1.5x, 2.5x, 3x, 30x, 60x and 180x; buttons to step to
  what happens next and back; the time of each entry under What happened leads to it.
- **The agent and its tools** moves whenever the agent works: tools beyond the six most
  used share a place, named while in use (a call to one of them drew nothing before); a
  ring spreads while it reads, thinks or writes; the line of a short call stays a moment
  and fades, so it can be seen when played fast; any number of subagents fits.
- **Install app**: in Chrome or Edge, the monitor in a window of its own with its own icon.
- **--lan**: open the monitor to the other devices of your network, each with an access
  key shown once (`--access-key` prints it). Off by default; this machine never needs it.
- Ship: a row that is not full stands in the middle; two stations of one folder are named
  by their titles; the console screen follows one rule, live and in a replay.
- A moving picture of the Replay tab in the README, in English and in Thai.

## 11.1.0 - 2026-10-10

Play a session back, and see the monitor before installing it.

- **Replay**, a new tab: one session played back from OpenCode's own records, with the rules
  of the Now tab, so it works for sessions the monitor never saw. A player with three speeds
  and the real time of each moment; the session's station on the bridge; the panel the Now
  tab would have shown then (state, what it was doing and for how long, calls so far, time
  waited for you, the context against the compaction point); the agent drawn with the tools
  it reaches for and its subagents at work; the plan as it stood; what had happened; and a
  timeline of every row. Labelled as a replay throughout, never taken for now.
- **Skip silences**, on by default: a stretch over two minutes where nothing happened takes
  twenty seconds of playback, and is marked on the timeline.
- **Replay links** at the foot of every card, and **Replay this session** in Stats and History
  when a session is chosen.
- **Screenshots in the README**, in English and in Thai, of `--sample` data; the sample now
  has a full session to play back, older than the Now tab looks, so nothing there changes.
- Fixed wording: "1 MCP servers were switched on" no longer counts, and the compactions
  sentence names files read again only when there were some.

## 11.0.0 - 2026-10-10

The Now tab as the bridge of a spaceship, live.

- **The ship**: a switch beside the heading of the Now tab shows the same sessions as a
  pixel-art bridge, moving as the cards change, every two seconds. One crew member per
  session, the ones that need you in front: a raised hand waiting for you, sweat when
  stuck, a red cross on error, arms up when done, asleep when idle. The console screen
  shows the tool, a fuel gauge the context with a tick where OpenCode compacts, drones the
  subagents, and lights on the wall the MCP servers. Pick a station to see its card; a
  legend says what each picture means. Cards stays the default, and your choice is
  remembered in that browser.
- **Long text never overflows**: only the folder name is written on the bridge, cut short to
  fit, and the bubbles say the state in a word or two, never quoting the session. Twelve
  stations at most, the rest counted; two columns on a phone. The picture holds still for
  anyone who asks for less motion. The crew and the ship are drawn in code for this project.
- **One kind of tooltip everywhere**: every tooltip is now shadcn's, the charts' hover cards
  included; none is left to the browser. A tooltip for text cut short opens only when the
  text really is cut.
- A long project name wraps on the cards instead of running out of them, and a card's clock
  lines up on the left when it drops under a long title.

## 10.2.0 - 2026-10-10

The README in Thai, and tidier code. Nothing the monitor shows or does has changed.

- **README.th.md**: the whole README in Thai, section for section, using the words the Thai
  page uses for tabs, states and buttons. Each language links to the other under its title,
  and a test keeps the two in step: the same sections, commands, tables, links, and every
  option, key and file named in one must be named in the other.
- Component props are read-only and no condition is nested in another, as SonarQube asked
  (code smells 126 to 39; what is left is mostly the long patterns of the review rules,
  kept as one pattern per rule on purpose).
- New tests for the header's status line, the environment strip and the list of models in
  `--doctor`, none of which had any.

## 10.1.0 - 2026-10-10

The same monitor, easier to read and to check. Nothing it shows or does has changed.

- No function is over SonarQube's complexity limit any more (18 were): the rules that decide
  a session's state, the Stats figures, the review of risky commands and the notifications
  are each split into named steps, in the same order as before. Every step was checked with
  the tests and with `npm run verify`, which still agrees on 143 of 143 figures.
- `npm run sonar` measures the test coverage of the server and of the page, then runs a
  SonarQube scan with it (`sonar-project.properties`). The server's token is read from the
  environment and never written to a file or a command line.

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
