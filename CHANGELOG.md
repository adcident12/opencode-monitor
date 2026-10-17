# Changelog

What each version added, newest first. The version that is running is shown next to the title
on the page and printed at startup.

## 11.12.0 - 2026-10-17

What is happening now for an assistant, loops and lost cache on the replay, and a correction.

- **opencode_now.** What the Now tab shows, for an assistant: every session of the last day,
  most urgent first, with what it waits on, the call it runs, its plan, its context and room
  before compaction, whether it is going round in circles, and the servers it depends on.
  At `/mcp` it is the monitor's own reading; `mcp.mjs` reads the sessions as the page does.
- **Replay marks.** Above each row of the timeline, a band where it went round in circles and
  a dot where its model read again what its server had cached; both are listed under What
  happened, a lost cache with its cause.
- **Kinds of notification not switched on.** A `notify.on` set in `config.json` is kept as
  it is when a version adds a kind, so This machine and `--doctor` say which kinds are on by
  default and not in yours (`"loop"`, `"budget"`). Never switched on by the monitor.
- **Budget notifications survive a restart.** What was told is kept in `data/budget.json`: a
  budget already spent when the monitor starts is told if it was not before, and never twice.
- **Correction to 11.11.** The calls an OpenCode 2 `execute` script makes were each counted as
  a call of the agent, so one script that called a failing tool 256 times read as the agent
  failing 257 times in a row. Each tool in a script now counts once; a script that loops by
  itself is told by Stats as a script that looped. On a month of real sessions the loops found
  are a page wait and a page script that each failed four times in a row, and plans that stood
  still for over an hour of work.

## 11.11.0 - 2026-10-17

Why the prompt cache was lost, an agent going round in circles, and what it cost.

- **Prompt cache lost, and why.** From the cached and new tokens OpenCode records for each
  request, for any server that reports them: each time a request read again most of what the
  one before it had cached, put down to its first cause that holds (a compaction or another
  model, which are expected; another session in between, a pause, a new turn, part of the
  prompt changed, or no cause seen). Stats lists them by cause with the time each took
  (`cacheDrops`), and "Worth knowing" names the cause that cost most. On this machine over a
  week, 128 of 316 losses were unexpected, 3.7M tokens.
- **The agent going round in circles.** The same calls back to back, one tool failing again
  and again, or an hour of work and 30 calls without its plan changing. The session says so,
  a `"loop"` notification tells once each time it starts (for a subagent too), and Stats
  lists each one of the period with "still going" (`loops`). The limits were set against a
  month of real sessions, past what ordinary work reached; they caught a script that failed
  257 times back to back. `"loop"` is on by default; a `notify.on` already set in
  `config.json` needs it added.
- **What it cost.** For a model with a price: today and this month, where the month ends at
  this pace, each day and month, by model and by session, as OpenCode recorded it (US
  dollars at list price). `budget.daily` and `budget.monthly` show the share used, and a
  `"budget"` notification tells at `budget.warnPct` and at the whole of it. Left out for
  someone who pays for nothing.
- **MCP keeps up.** `opencode_stats` has `cacheDrops` and `loops`, and `opencode_costs` is new,
  over `mcp.mjs` and `/mcp` alike.
- **OpenCode 2 prompts asked for by path.** `opencode api GET /api/session/<id>/permission`
  in place of the operation name, which made OpenCode send its whole API description
  (276 KB) on every question. Its event stream would need the service password, which can
  answer prompts and run anything, so the monitor still does not read it.
- **npm run release** checks are tested; the sample has a loop and a priced model to show.

## 11.10.0 - 2026-10-17

Prompts read again, a model server that stops, and a README true to the system.

- **Prompts read again from the start.** While a session waits on a llama.cpp server, the
  monitor sees in its slots when a request finished reading its prompt. Each read of 8,192
  tokens or more is kept in `data/reads.jsonl` (when, how many tokens, how long it was seen
  reading), and Stats sums them (`longReads`), with a "Worth knowing" sentence from ten minutes
  in a period. The first live run caught one of 99,442 tokens that kept a session waiting two
  minutes before its first word.
- **Told when the model server works on nothing.** `"server_idle"` in `notify.on`, on by
  default: a session waits on its llama.cpp server and the server has worked on no request
  for a minute, so it may have dropped this one. Told once, until it works again. A
  `notify.on` already set in `config.json` needs it added.
- **verify does not call a moment a bug.** A figure that differs while OpenCode is writing is
  counted again from the start, once, and only that count is reported; a session still
  working is not compared across two of the monitor's answers.
- **npm run release.** A release is checked before it is made (the branch, nothing
  uncommitted, a changelog entry dated today, the tests), then made with `--yes`.
- **README.** Contents, a summary of the features, Getting started, each tab in the order of
  the page, every setting the monitor reads, the files it writes, Troubleshooting, and a
  Development section; and made true to the system where it had fallen behind.

## 11.9.0 - 2026-10-17

What the model server is doing, and which model really answered.

- **What the model is doing while a session waits on it.** The session's card says what the
  llama.cpp server is doing for it, read from its slots every three seconds while it waits:
  reading the prompt (how many tokens so far, how fast), writing (how many, how fast), or
  not working on any request for a minute, which is the server, not the agent. llama.cpp does
  not say how long a prompt is until it has read it all, so no share and no time left is
  given: they would be guesses. With two sessions waiting on one server nothing is shown,
  since which slot serves which is not known.
- **Which model really answered.** The monitor keeps which model each server had loaded and
  when (`data/served.jsonl`), and Stats says how many replies OpenCode named after another
  model than the one loaded (`servedAs`), with a "Worth knowing" sentence from ten on. The
  figures stay under the names OpenCode recorded; only a server started with `--alias` is
  compared, and only while the monitor was running.
- **MCP.** `opencode_overnight` answers "what happened while I was away" for the latest night
  or one up to six back, and `opencode_settings` says what each model server really runs and
  where OpenCode thinks otherwise. The MCP process reads the history without ever writing it.

## 11.8.0 - 2026-10-17

While you were away, and what the model server really runs.

- **While you were away.** At the top of the Tasks tab, a report of the latest night
  (`overnight.from` to `overnight.to`, 22:00 to 08:00 by default), from the monitor's record
  of each change of state: each session that ran, how long it worked and waited for you, how
  it stood at the end and why, its plan; and above them, the longest stretch in which nothing
  ran while a session needed you. On this machine it shows the night llama-server went down:
  nothing ran from 03:40 to 07:30. With `notify.overnight.enabled` it goes to Discord once
  the night ends; off by default.
- **What a llama.cpp server really runs.** The model-server check also reads the server's
  own settings (`/props`): the model loaded (its `--alias`) and the context it was started
  with, on hover. It turns red when a session working now asks for another model than the
  one loaded, or when OpenCode takes the context to be larger than the server's. A server
  that wants a key is read only with `modelServerKeys`, which names where the key is
  (`{env:NAME}` or `{file:path}`) and refuses the key itself; one that refuses is asked once
  per start, so its log does not fill with failed logins.
- **MCP connected.** OpenCode 2 logs each MCP connection and how many tools it offered: a
  server it connected shows *connected* before any of its tools is used, where it showed *no
  signal*, and one that offered no tools shows so in grey, not as a failure (graft offers its
  tools only in a project it has indexed).
- **SonarQube.** The quality gate passes again: 35 issues in the code since 11.3 fixed with
  no change in behaviour, and Linux programs (`ps`, `lsof`, `systemctl`, `notify-send`) run
  from the system's folders by full path, never found through PATH.
- A link-local address (169.254.x.x) is no longer offered as one of this machine's LAN
  addresses.

## 11.7.0 - 2026-10-15

The MCP tools from another machine of the network.

- **MCP at `/mcp`.** Claude Code on another machine, such as the server that runs your
  models, can use the monitor's MCP tools over HTTP (MCP's Streamable HTTP transport, plain
  JSON). Only with `--lan`, and only with the page's access key, sent as an
  `Authorization: Bearer` header. A browser page from any other origin is refused, and the
  tools are read-only as over stdio. `node server.mjs --access-key` prints the
  `claude mcp add` command for each address of this machine.

## 11.6.0 - 2026-10-15

What you set the agent to do, and how far each got.

- **Tasks.** With many sessions going, it is easy to lose track of what was asked and where
  each stands. The new Tasks tab (and `opencode_tasks` over MCP) lists every session of the
  last 7, 14 or 30 days by project: its title, how its last turn ended (working, waiting for
  you, probably stuck, interrupted, stopped on an error, or handed back to you), and the
  agent's plan as done of total with the items still to do. Unfinished sessions first;
  "Unfinished only" hides the rest. Your prompts are not read: the title is OpenCode's
  summary of the first one.
- **OpenCode 2's plans on the Now tab.** OpenCode 2 keeps no todo table: its plan is only in
  the agent's latest `todowrite` call. The monitor read the table alone, so no OpenCode 2
  session showed its plan. It does now, and a finished session whose plan was left part
  done shows how far it got.
- **The OpenCode in use** is the one its log says started last. A 1.x session carried on in
  OpenCode 2 keeps the version that created it; the monitor took that as the version in
  use, so This machine said 1.18.35 while 2.0.28 was running, and that session was held to
  the 1.x compaction rule on the Now tab.

## 11.5.0 - 2026-10-14

What a change did, read off the figures: before and after it, one model at a time.

- **Before and after a change** (`opencode_compare`, for an assistant over MCP). The same
  figures for the hours before a moment, by default the newest change to the config, and
  the hours after it, each per hour of agent time: compactions and how long they took, files
  read again after a compaction (whole or a range, and whether an edit followed), calls over
  two minutes with the longest of them and what they ran, interrupted turns, failures per
  tool, the share of time thinking, permission waits. `model` counts one model's work on
  both sides; without it, a comparison across a change of model says it is not reliable.
- **Rates since the newest change.** A takeaway about a rate (a tool failing, where the time
  went, the prompt cache) is read from the figures since the newest change of the config or
  of the model that has an hour of work after it, and says so. A tool that failed often
  before a change and no longer does is said as fixed. An `execute` script that looped (more
  than 50 calls) is its own line, out of the tool's failure rate.
- **Time spent compacting**, in all and per session, the models each session used, and two
  takeaways: when summarising takes a real share of the agent's time, and a session that
  went on through 20 compactions or more.
- **How long each model's replies are** (p50, p95, p99, longest) in `opencode_settings`,
  with a note when `compaction.buffer` is shorter than the longest reply or far longer than
  needed, and which model the config uses now.
- **An MCP server OpenCode 2 failed to connect**, in a folder, is not tried again by
  OpenCode. `opencode_settings` lists where it is down, with the command that connects it.
- **A permission rule already in the config** is not suggested again: the prompt it would
  have answered says it is allowed now.
- **A second monitor** that cannot have the port no longer reads anything: it had recorded
  each config change a second time.

## 11.4.0 - 2026-10-14

OpenCode 2, by its own rules: where it compacts, what it gave up on, and what it runs in the background.

- **`mcp.timeout` is not an MCP server.** OpenCode 2 keeps settings beside the servers in the
  `mcp` section (`timeout`), and the servers themselves may be under `mcp.servers`. The
  monitor took every key for a server: a "timeout" server showed with no signal, and Stats
  said it was switched on but never called.

- **Told when OpenCode stops on an error**: `"error"` is in `notify.on` by default. A reply
  that failed and stays failed for a minute, such as the model server going down, is told
  once; one OpenCode retries by itself within the minute (llama.cpp's "bad allocation" three
  times on this machine, each retried within two seconds) is not. Found when a server that
  went down at 03:40 left a session stopped for four hours without a word.
- **Read from OpenCode 2's own source** (2.0.26), and changed where the monitor had guessed:
  - A shell command OpenCode 2 runs in the background says so (`background: true`), with
    no `&` in it: such commands are flagged as background now, for the review and for the
    processes left running. 18 on this machine had been missed.
  - A fork copies its parent's history into itself; that history is counted once, in the
    parent.
  - The project is put away after exactly 60 minutes without activity, not configurable;
    OpenCode records only that the session was interrupted, not why, which is why the
    monitor reads it from the log.
- **Where OpenCode 2 compacts.** It has a rule of its own: the window less
  `compaction.buffer`, or less a tenth of it (at least 16,000), the output limit no part of
  it. Read from OpenCode's own source and followed for its sessions; `compaction.buffer` is
  read from the config. Checked against 1,644 real requests of 2.0.26. With it, 2.0.26 is the
  release the monitor is checked against, and the notice that it is newer goes.
- **A prompt nobody answered, dropped.** OpenCode 2 puts a project away after an hour without
  activity; a question or permission prompt left open goes with it and the session stops.
  The monitor reads that from OpenCode's log: the session says "OpenCode stopped waiting"
  where it said "Stopped by the user", and a notification is sent once (`"dropped"` in
  `notify.on`, on by default).

## 11.3.1 - 2026-10-12

A question nobody answered is not an answered one.

- OpenCode 2 puts a project away after an hour without activity, and a question left open
  goes with it: the call ends, interrupted, and the session stops. Stats counted that
  question as answered after an hour. It is counted as never answered now, waiting until
  the moment it was dropped; so is one you stopped yourself.
- `npm run verify` reads OpenCode 2's rows again before each view. While OpenCode was
  writing, a count made from rows read a minute before was reported as a difference.

## 11.3.0 - 2026-10-11

OpenCode 2, read next to 1.x.

- **OpenCode 2.** Sessions written by OpenCode 2 (`session_v2`, `session_message`) are read
  next to those of 1.x, in every tab and in the MCP tools. Renamed tools keep their 1.x
  names (`shell` is `bash`, `subagent` is `task`); an `execute` script counts as the MCP
  calls it made, per server. OpenCode 2 copies every 1.x session into its own tables: a
  message is read from there only when it is newer than what the 1.x tables hold for its
  session, so nothing is counted twice and a 1.x session carried on in 2 is whole. A 1.x
  database, without the new tables, is read exactly as before.
- **Waiting for you, in OpenCode 2.** It records a permission prompt neither in its database
  nor in its log, so the monitor asks OpenCode itself: `opencode api session.permission.list`
  for a session, only while one of its tool calls is running: every five seconds at first,
  then every fifteen, then once a minute for a call that has run for half an hour.
  It lists and never answers. The session shows as waiting, with what it asks for, from the
  moment it asked; the prompts seen are kept in `data/prompts.jsonl` so that Stats counts how
  long they waited. Questions are read from the `question` calls themselves. `opencodeApi` in
  config.json switches it off or names the command; This machine says when it does not work.
- A session of OpenCode 2 that is compacting says so, and what the compaction cost is
  counted. An `execute` script that was interrupted, or is still running, is one call: no MCP
  call is counted for it unless OpenCode lists it.
- The compaction point shown is 1.x's rule. OpenCode 2 compacts a little sooner about half
  the time (18 of 33 automatic compactions before it, the earliest 5% before), so the notice
  that 2.x is newer than the release the monitor was checked against stays.
- Thinking and writing are an estimate for OpenCode 2: it times them as one, so the time is
  shared out by the length of what was written (on 1.x data, 106% of the thinking and 95% of
  the writing).
- A database made by OpenCode 2 alone has none of the 1.x tables; the monitor refused it. It
  is read now, the missing tables stood in for by empty ones held in memory (the file stays
  read-only).
- A command that only asks the running OpenCode something (`opencode api ...`) is no longer
  taken from the log for an OpenCode of its own, which could hide the one that is running.
- `npm run verify` counts OpenCode 2's rows as well, separately from the monitor's own code.
- A model server is asked for `<baseURL>/health`, no longer for its list of models: a server
  that wants a key answered the list with 401 and wrote a failed login in its own log at
  every check (2,456 lines in 19 hours on one llama.cpp server).

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
