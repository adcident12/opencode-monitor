# opencode-monitor

A local status page for [OpenCode](https://opencode.ai). It answers one question at a glance: is the agent **working**, **waiting for you**, **probably stuck**, **finished**, or **failed**?

It exists because of things like a permission prompt sitting unanswered for eight hours overnight while it looked like the agent was busy.

- **Read-only.** It reads what OpenCode already stores on disk and changes nothing in OpenCode.
- **Local.** Binds to `127.0.0.1` only. No telemetry. Nothing leaves your machine unless you configure a Discord webhook.
- **No install step.** The server uses built-in Node modules only, and the page comes pre-built. npm is needed only to change the page (see [dashboard/](dashboard/README.md)).
- **Secrets are hidden by default** before anything is displayed or sent.

> **Contributions are not accepted.** Pull requests are closed without review and feature requests are not taken. Bug reports are welcome as issues. You are free to fork and change your own copy (MIT). Details: [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it

Needs Node.js 22.13 or newer.

```sh
git clone https://github.com/adcident12/opencode-monitor.git
cd opencode-monitor
node server.mjs
```

Open <http://127.0.0.1:4317>.

To see it without OpenCode, run it on generated fake data:

```sh
node server.mjs --sample
```

| Option | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on (default 4317) |
| `--data-dir <path>` | OpenCode data directory, the one holding `opencode.db` |
| `--config <path>` | Settings file (default `config.json` next to `server.mjs`) |
| `--lang <code>` | Language for notifications (`en`, `th`) |
| `--sample` | Use generated fake data |
| `--no-notify` | No desktop or Discord notifications |
| `--assume-running` | Skip the check for a live OpenCode process |
| `--version` | Print the version, then exit |
| `--doctor` | Print what the monitor finds on this machine, and what is missing, then exit |
| `--test-notify` | Send one sample of every kind of notification that is on (`notify.on`), on each channel, and print how each was received |
| `--autostart on` / `off` | Start the monitor each time you log in, or stop doing so, then exit |

### What it found on your machine

Nothing in the monitor is set for one particular machine: paths, model limits, the point where a session is compacted, MCP servers and notification channels are all read from where it runs. The **This machine** tab says what was read and from where, and `node server.mjs --doctor` prints the same in a terminal, without needing the page:

- where OpenCode's database, log and config were looked for, and whether they are there;
- the models used in the last 30 days, each with its context window, output limit and the size at which OpenCode compacts a session of that model, or "limit unknown" when no limit is set for it anywhere;
- which notification channels are on (a Discord webhook is reported as set, never shown);
- **To look at**: each thing that is missing, what it costs you, and what to change.

Start here when a figure is not shown that you expected to see.

### Keep it running

The monitor is only useful while it runs, and a prompt left unanswered overnight is exactly when a forgotten terminal has been closed. On Windows:

```sh
node server.mjs --autostart on
```

registers a scheduled task named `opencode-monitor` for your user (no administrator rights needed) that starts the monitor at each login, without a console window. Options given with it (`--port`, `--data-dir`, `--config`, `--lang`, `--no-notify`) are kept. `schtasks /Run /TN opencode-monitor` starts it right away, and `node server.mjs --autostart off` removes the task. The task points at this folder and at the Node you ran it with, so run it again after moving either.

On macOS the same command writes a launchd agent to `~/Library/LaunchAgents/com.opencode-monitor.plist` (output goes to `~/Library/Logs/opencode-monitor.log`), and on Linux a systemd user unit to `~/.config/systemd/user/opencode-monitor.service`; both start the monitor at once and at every login, and `--autostart off` removes them. On all three systems CI does this for real on every push: it turns autostart on, waits for the monitor that the system started to answer, turns it off, and checks that it is gone. What CI cannot show is a desktop login after a reboot; if the monitor is not there after you log in, `--doctor` and the system's own log (`journalctl --user -u opencode-monitor`, or `~/Library/Logs/opencode-monitor.log`) say why.

## What the states mean

| State | How it is decided |
| --- | --- |
| Waiting for you | A `question` tool call is open, or a permission prompt was logged for a tool call that has not moved since. Subagent prompts show on the parent session too. |
| Probably stuck | One tool call has run longer than `stuckToolMinutes`, or nothing at all has happened for `silentMinutes` while the model owes a reply. |
| Error | The last model request failed, or the reply hit the output token limit. |
| Working | A tool is running, or the model is producing the next step. |
| Finished | The agent ended its turn normally. |
| Idle | No messages yet, stopped by the user, or OpenCode was closed mid-task. |

A failed tool call alone is not an error state, because agents normally recover from those. Failed calls are counted under session health instead.

For a session that is still going, the page also shows how far it has got:

- the running command, the last lines it printed, and how long ago the last line arrived. "Running for 35 minutes, last output 34 minutes ago" is what a hung command looks like;
- when anything at all last happened in the session;
- the latest tool calls of the current turn with their result and duration;
- the agent's own task list, if it keeps one.

OpenCode stores a model reply only when it starts and when it ends, so while the model is writing there is no partial text to show, only how long it has been quiet.

Each session also shows its health: context used against the model's limit, number of compactions, session age, failed tool calls, and whether the same command keeps repeating. The context bar has a tick where OpenCode will compact the session. Nothing about that point is fixed in the monitor: it is worked out for each session with OpenCode's own rule, from the limits you set for that model in `opencode.json` (the project's file over the global one):

- reply = the smaller of `limit.output` and 32,000 (or `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`)
- a model with `limit.input`: `limit.input` − (`compaction.reserved`, or the smaller of 20,000 and reply)
- any other model: `limit.context` − reply
- `compaction.auto: false`: never, and the card says so

So a 32,768 window with 4,096 output compacts at 28,672, and a 131,072 window with 32,768 output at 99,072. Under the bar the page says how many tokens are left before that and, from how much the last few requests grew, roughly how many requests. It warns once the session is 85% of the way there or 3 requests away (`thresholds.compactWarnPct`, `thresholds.compactWarnRequests`). When these look bad the page suggests starting a new session.

## Environment

A strip at the top shows the things the agent depends on:

- **Model server**: providers in OpenCode's config that have their own `baseURL` are asked for `<baseURL>/models` (no credentials sent; any answer below HTTP 500 counts as up). By default only addresses on this machine or network are checked; set `environment.modelServers` to `"all"` to include others, or `"off"`.
- **MCP servers**: OpenCode only logs MCP failures, so status is inferred. *Failed* means the running OpenCode logged the server failing, or a tool call found the connection gone, and none of its tools has worked since. *OK* means one of its tools completed. *No signal* means neither. Servers that a project's own `opencode.json` adds or switches on are included for the sessions on screen. Connections that close because OpenCode itself quit are not failures.
- **Services**: anything you list under `services` in `config.json`, by URL or by host and port.

With `notify.environment` on, you are notified once when any of these goes down.

## What the agent did

Each session card has two fold-out sections.

**Work** shows the files the agent touched and the git branch the project is on. It warns whenever the session is on a protected branch (`main` or `master` by default), whether or not any file change was detected: the file count only covers the edit tools, not changes made through shell commands.

**Still running** lists processes this session started in the background (a dev server via `Start-Process`, `nohup`, `docker compose up -d`) that are still alive, with their PID, the ports they listen on, and the command to stop them yourself. A process is matched to the command that started it by start time (within a minute after it) and shared words, so check the command before stopping anything. The monitor never stops processes. Turn it off with `work.processes: false`.

**To review** is a hint list, not a security control. It lists tool calls worth a second look, with whether you were prompted for it (*you were asked, then it ran*, *allowed by a rule, no prompt*, or *you refused*):

| Kind | Examples |
| --- | --- |
| Risky | commands built at run time that cannot be read (`eval`, encoded or piped-in scripts), recursive delete, killing processes, force push, `git reset --hard`, `DROP TABLE`, `docker system prune`, piping a download into a shell |
| Secret values | a secret-looking value in a command or in a tool result (shown redacted; the original is still in OpenCode's own database) |
| Secret files | reading `.env`, private keys, credential files |
| Outbound | `git push`, publishing, requests to hosts outside your network, `ssh`/`scp` |
| Background | commands that leave a process running (`Start-Process`, `nohup`, `docker compose up -d`) |

These are pattern matches meant to point you at things to check. They do not prove anything happened, and a command phrased unusually will not be caught. OpenCode logs that it asked but not what you answered, so "you were asked" is inferred from a prompt logged at the moment the call started.

If a rule is only noise for you, list it under `review.ignoreRules` in `config.json` (rule names are the `rule.*` keys in `i18n/en.json`, for example `"kill_process"` or `"background"`). Calls flagged by the same rule are shown as one entry with a count and every distinct command in it, so a harmless command cannot cover for a dangerous one under the same rule. Anything cut for length, or left out by `review.ignoreRules`, is counted on the page rather than dropped silently.

## Stats

The **Stats** tab looks back over the last 7, 14, or 30 days, from OpenCode's own records, so it covers days when the monitor was not running:

- how long prompts waited for you in total, the typical time to answer, and the longest waits;
- how many tool calls hung (ran longer than `stuckToolMinutes`), and the slowest ones;
- time the agent spent working, per day;
- calls per tool and how many failed, how often graft was used instead of read/grep/glob, files read again and again in one session, and skills loaded;
- one row per **MCP server**: calls, time per call, when it was last used, how often its connection dropped or it failed to start, and its most used tools. Failures are split in two: *failed* is a tool reporting an error (a script with a typo), *no answer* is the server itself not responding (connection closed, request timed out). Servers that are switched on but were never called are named, because each one still adds its tool list to every prompt.

- **model speed**, per model: tokens per second while writing, tokens per second while reading the new part of a prompt, and the typical wait for the first token, with writing speed per day for the model used most. Writing is timed from the first token to the last thing the model wrote, so a tool running or a prompt waiting for you does not make the model look slow.
- **tokens**: how much was sent to the model, how much of that the model server could reuse from its cache, how much the model wrote, and the cost when OpenCode recorded one. Also how big a session is at its first request, before any work: instructions, skills, and the tool list of every MCP server that is switched on. That is the number to watch when deciding which MCP servers to leave on.

Pick a session next to the period to see the same figures for that session and its subagents only. Each session card on the first tab links straight to its own Stats and History (`#stats/<session id>`, so the view can be bookmarked).

**Context of one session.** With a session selected, a chart shows the size of each of its requests in order, against the model's context window, with a dashed line at every compaction. Under it, each compaction is listed with what it shrank the context from and to, and how many files the agent had already read and then read again afterwards: the cost of a compaction that the token count alone does not show.

**Before and after.** Changed a setting (switched an MCP server off, moved to another model, edited `AGENTS.md`)? Pick the day you did it under "Compare from", and the days before it are set beside the days from it on: tokens a session starts at, compactions and re-read files per session, failed tool calls, cache reuse, model speed. Only rates and typical values are compared, because the two sides are rarely the same length, and each change is labelled better or worse. With fewer than 3 sessions on one side the page says the difference is only a first hint.

The size of each MCP server's tool list is not shown: OpenCode does not record the tool definitions it sends, so it could only be measured by starting every server, which the monitor does not do.

A question's answer time comes from OpenCode's log. A permission's does not exist in any record, so it is taken as the next update to the tool call the prompt blocked. Prompts and calls left unfinished when a session moved on or OpenCode closed are counted separately, not as days of waiting. The time a call spent waiting for your permission is not counted as the call being slow.

## History

The **History** tab lists every change of state, newest first: when a session started waiting, how long it had been working before that, what it was running when it got stuck. Above the list, **What each session took** ranks the sessions of the last 30 days by agent working time, with time spent waiting for you, compactions, and tokens, subagents included and taken from OpenCode's own records. Click a session to follow it in the list below. "Download as CSV" saves that table; in Stats, "Download days as CSV" saves the figures per day. The files are built in the page from what it already shows, with titles that look like spreadsheet formulas escaped.

Tick "Only what needed you" to see just the waits, hangs, and errors, or pick one session to follow it from start to finish. The newest 100 entries are shown; "Load older entries" brings the next 100, and new entries keep appearing at the top without moving what is already loaded. Both filters are applied to the whole record, not only to what is on screen.

History is recorded only while the monitor is running, into `data/history.jsonl` (git-ignored, one JSON object per line, already redacted). Entries older than `history.retentionDays` are removed at startup. Set `history.enabled` to `false` to turn it off. Delete the file to clear it.

## Settings

Copy `config.example.json` to `config.json` and edit it. `config.json` is git-ignored. Every key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `thresholds.stuckToolMinutes` | 10 | A tool call running longer than this is "probably stuck" |
| `thresholds.stuckToolMinutesByTool` | `{ "task": 60 }` | Per-tool overrides |
| `thresholds.compactWarnPct` | 85 | Warn when the context is this full against the point where OpenCode compacts |
| `thresholds.compactWarnRequests` | 3 | ...or when this few requests of the usual size are left before it |
| `thresholds.silentMinutes` | 10 | Silence from the model before "probably stuck". Raise it for slow local models |
| `lookbackHours` | 24 | Only sessions active in this window are listed |
| `contextLimit.models` | `{}` | Context window per `provider/model`, if it cannot be read from OpenCode's config |
| `redact.extraPatterns` | `[]` | Extra regular expressions to hide |
| `environment.modelServers` | `"local"` | Which model servers to check: `"local"`, `"all"`, or `"off"` |
| `environment.checkSeconds` | 15 | How often model servers and services are checked |
| `services` | `[]` | Extra things to watch: `{ "name", "url" }` or `{ "name", "host", "port" }` |
| `work.git` | `true` | Read the branch name of each project directory |
| `work.processes` | `true` | Look for background processes the agent started that are still running |
| `review.ignoreRules` | `[]` | Rules to leave out of "To review" |
| `work.protectedBranches` | `["main","master"]` | Warn when the agent changes files on these |
| `notify.environment` | `true` | Notify when an MCP server, model server, or service goes down |
| `history.retentionDays` | 30 | How long state changes are kept in `data/history.jsonl` |
| `notify.on` | `["waiting","stuck"]` | States that trigger a notification. Add `"compact_soon"` to be told once when a session is about to be compacted |
| `notify.repeatMinutes` | 30 | Remind again while the state lasts; 0 turns reminders off |
| `notify.desktop` | `true` | Desktop notification |
| `notify.discord.webhookUrl` | `""` | Discord webhook; also settable as `OPENCODE_MONITOR_DISCORD_WEBHOOK` |
| `notify.discord.mention` | `""` | For example `<@123456789>` to ping yourself |
| `notify.discord.includeDetail` | `false` | Also send the (redacted) command or question text |

### Discord

In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. Put it in `config.json` or the environment variable. Treat the URL as a password.

By default a Discord message carries only the state, the project folder name, the session title, and how long it has lasted. Command text stays on your machine unless you turn on `includeDetail`.

## Where the data comes from

- `opencode.db` in OpenCode's data directory (`~/.local/share/opencode`, or `$XDG_DATA_HOME/opencode`), opened read-only: sessions, messages, and parts.
- `log/opencode.log` in the same directory: the only place permission prompts are recorded.
- OpenCode's config (`~/.config/opencode/opencode.json[c]`): model context limits, MCP server names, and model server addresses. API keys and MCP credentials in those files are never kept.
- Each project directory's own OpenCode config (`opencode.json[c]`, also under `.opencode/`), for the names of MCP servers it adds or switches on. Only small regular files on a local disk are read, and only names, types and the enabled flag are kept.
- The process list, to tell whether OpenCode is running.
- Each project directory: one file, `.git/HEAD`, for the branch name. The `git` program is never run, because git executes programs named in a repository's own config, and the agent can write that config. Commits and uncommitted changes are therefore not shown.
- HTTP or TCP checks against the model server and the services you configured.
- The process list and listening ports (Windows: `Get-CimInstance Win32_Process` and `netstat`; macOS and Linux: `ps` and `lsof`), only while a session on screen has started something in the background.

## Limits

- `--autostart` is exercised by CI on Ubuntu, macOS and Windows runners, not on a desktop across a reboot.
- **Tested with OpenCode 1.18.35 on Windows 11 (Node 24).** The test suite also runs on Linux and macOS with Node 22 and 24 in CI, against generated sample data. Running next to a real OpenCode on Linux or macOS, and desktop notifications there (`notify-send`, `osascript`), have not been tried yet. Bug reports are welcome as issues.
- OpenCode's database layout is not a public interface. The monitor checks the tables and columns it needs at startup and refuses to run if they are missing, but a subtler change could still produce wrong states.
- **Pending permission prompts are inferred.** OpenCode does not record the answer to a prompt, so the monitor treats a prompt as pending while the tool call it belongs to is still running and untouched. Two sessions prompting within the same two seconds could be confused.
- MCP status is inferred from failure lines in the log plus tool calls.
- Which OpenCode processes are still running is read off the log: a run that logged its own shutdown is over; of the rest, the one that wrote last is alive, and so is any other that has written since that one started. So a one-off command such as `opencode mcp list` no longer hides what the open window logged, and two windows are both followed. A window that has logged nothing since a newer one started is still missed, and one that was killed leaves no shutdown line.
- Model speed needs OpenCode to have recorded when a reply's first token arrived and when its text or tool call was complete. Replies without both are left out, and so are replies too short to time (under 20 output tokens for writing, under 500 new prompt tokens for reading). When a reply calls several tools, the ones that ran while the model was still writing the next call are inside the writing time.
- In the context chart, the size a compaction left behind is the smallest of the three requests after it, because the first is usually the summarising call that still carries everything. "Read again" counts files read before a compaction and again before the next one; a file re-read for a good reason (it changed) is counted the same. Subagents have their own context and are not drawn.
- Before and after is a split by calendar day, nothing more. It does not know what you changed or whether anything else changed with it (a different project, a different kind of task), and a session that runs across the chosen midnight has its calls counted on both sides by the day they happened.
- The compaction point follows OpenCode's settings, not the model server's. If the server's real context is smaller than `limit.context` (for llama.cpp, `--ctx-size`), the server refuses a request before OpenCode would have compacted; OpenCode records that compaction as forced, and the monitor then says the two do not match. It cannot see the server's own setting. A model that is not in `opencode.json` or OpenCode's model catalogue has no known point, and none is guessed.
- The rule was read from OpenCode 1.18.35 and checked against every automatic compaction in a real database (237 of 237). A later OpenCode may change it.
- Token counts are the model server's own, per request. A server that reports none (some local servers do not report cached tokens) shows zeros, and "how big a session starts" needs the session's first request to fall inside the period.
- A closed MCP connection is taken as OpenCode shutting down when it is the last thing a finished run logged, or when two or more servers close within two seconds. Several servers really dying in the same moment would be missed, and with a single server configured a shutdown of the running OpenCode looks like a failure.
- MCP tool calls are attributed by name (`<server>_<tool>`). A server whose project config has since been deleted or renamed is not recognised, and its calls stay in the plain tool list.
- Dropped connections and failed starts are counted from OpenCode's log, which does not say which session they happened in and is eventually rotated. They are left out when one session is selected, and the page says so when the log starts later than the period shown.
- Secret detection in tool results reads only the first 8,000 characters of each result.
- Only the branch name is read from a repository, from `.git/HEAD`. A worktree or submodule (where `.git` is a file pointing elsewhere), a `.git` or `HEAD` that is a link, and a project on a network path are not read; they show "git state unreadable" with a warning, never a clean result.
- Between checking `.git/HEAD` and opening it there is a short window in which a process racing the monitor could swap it for a link. Node offers no way to close that window completely; what is read is only ever interpreted as a branch name.
- A session whose OpenCode window crashed looks stuck until OpenCode is closed entirely or the session falls out of the lookback window.
- Redaction is pattern-based: known token formats, passwords in URLs, and values of names such as `TOKEN`, `KEY`, `PASSWORD`. A secret with no recognisable shape will not be caught.
- View only. There are no controls that act on the agent.

## Layout

```
server.mjs              entry point, Node version check
src/config.mjs          defaults, config.json, command line
src/db.mjs              read-only queries, schema check
src/logtail.mjs         follows opencode.log for prompts
src/state.mjs           state and health rules (pure, unit-tested)
src/monitor.mjs         polling, caching, redaction of the snapshot
src/audit.mjs           rules for risky, outbound, and secret-touching calls
src/environment.mjs     MCP, model server, and service checks
src/mcp.mjs             MCP figures: which server a tool belongs to, real failures vs shutdowns (pure)
src/git.mjs             branch name per project (reads .git/HEAD only)
src/stats.mjs           figures for the Stats tab (pure); stats-source.mjs reads and caches them
src/leftovers.mjs       background processes still running, matched to the command that started them
src/history.mjs         record of state changes (data/history.jsonl)
src/redact.mjs          secret patterns
src/notify.mjs          desktop and Discord notifications
src/process.mjs         is OpenCode running
src/setup.mjs           what was found on this machine, for the This machine tab and --doctor
src/autostart.mjs       --autostart: the scheduled task that starts the monitor at login (Windows)
src/opencode-config.mjs model limits, MCP names, model server addresses
public/                 the page, built from dashboard/ (do not edit by hand)
dashboard/              source of the page: Next.js, Tailwind CSS, shadcn/ui
src/static.mjs          serves public/ with a strict Content-Security-Policy
i18n/                   UI and notification strings (en, th)
scripts/make-sample.mjs fake data for --sample and the tests
scripts/ci-autostart.mjs turns autostart on and off for real; run by CI on each system
```

To add a language, copy `i18n/en.json` to `i18n/<code>.json`, translate the values, add the code to `LANGUAGES` in `dashboard/lib/i18n.tsx`, and rebuild the page (`npm run build` in `dashboard/`).

```sh
npm test
```

## Versions

The version is the one in `package.json`. It is printed when the monitor starts, shown next to the title on the page, and `node server.mjs --version` prints it alone. [CHANGELOG.md](CHANGELOG.md) says what each version added.

Work on a version happens on a branch named after it (`v6`), and `main` is moved to it when it is done. The released commit is tagged `v6.0.0`.

## Contributing

This project does not accept code contributions. Pull requests are closed without review, whatever their quality, and feature requests are not taken; bug reports are welcome as issues, with the output of `node server.mjs --doctor`. The reasons, and what you are free to do with the code, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Not affiliated with OpenCode

This is an independent project. It is not made, endorsed or supported by the makers of OpenCode. "OpenCode" appears in the name only to say what the tool watches. The OpenCode name and logo belong to their owners; this project does not use that logo. Its own mark, an open ring with a dot, is drawn in `dashboard/lib/logo.ts` and shares no shape with it.

## License

[MIT](LICENSE)
