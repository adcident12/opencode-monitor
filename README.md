# opencode-monitor

A local status page for [OpenCode](https://opencode.ai). It answers one question at a glance: is the agent **working**, **waiting for you**, **probably stuck**, **finished**, or **failed**?

It exists because of things like a permission prompt sitting unanswered for eight hours overnight while it looked like the agent was busy.

- **Read-only.** It reads what OpenCode already stores on disk and changes nothing in OpenCode.
- **Local.** Binds to `127.0.0.1` only. No telemetry. Nothing leaves your machine unless you configure a Discord webhook.
- **No install step.** One Node script and one HTML page, built-in Node modules only.
- **Secrets are hidden by default** before anything is displayed or sent.

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

Each session also shows its health: context used against the model's limit, number of compactions, session age, failed tool calls, and whether the same command keeps repeating. When these look bad the page suggests starting a new session.

## Environment

A strip at the top shows the things the agent depends on:

- **Model server**: providers in OpenCode's config that have their own `baseURL` are asked for `<baseURL>/models` (no credentials sent; any answer below HTTP 500 counts as up). By default only addresses on this machine or network are checked; set `environment.modelServers` to `"all"` to include others, or `"off"`.
- **MCP servers**: OpenCode only logs MCP failures, so status is inferred. *Failed* means the running OpenCode logged the server failing and none of its tools has worked since. *OK* means one of its tools completed. *No signal* means neither.
- **Services**: anything you list under `services` in `config.json`, by URL or by host and port.

With `notify.environment` on, you are notified once when any of these goes down.

## What the agent did

Each session card has two fold-out sections.

**Work** shows the files the agent touched, the current git branch, and commits made in that repository since the session started. It warns when changes are landing directly on a protected branch (`main` or `master` by default).

**To review** lists tool calls worth a second look, with whether you were prompted for it (*you were asked, then it ran*, *allowed by a rule, no prompt*, or *you refused*):

| Kind | Examples |
| --- | --- |
| Risky | commands built at run time that cannot be read (`eval`, encoded or piped-in scripts), recursive delete, killing processes, force push, `git reset --hard`, `DROP TABLE`, `docker system prune`, piping a download into a shell |
| Secret values | a secret-looking value in a command or in a tool result (shown redacted; the original is still in OpenCode's own database) |
| Secret files | reading `.env`, private keys, credential files |
| Outbound | `git push`, publishing, requests to hosts outside your network, `ssh`/`scp` |
| Background | commands that leave a process running (`Start-Process`, `nohup`, `docker compose up -d`) |

These are pattern matches meant to point you at things to check. They do not prove anything happened, and a command phrased unusually will not be caught. OpenCode logs that it asked but not what you answered, so "you were asked" is inferred from a prompt logged at the moment the call started.

If a rule is only noise for you, list it under `review.ignoreRules` in `config.json` (rule names are the `rule.*` keys in `i18n/en.json`, for example `"kill_process"` or `"background"`). Identical calls are shown once with a count.

## History

The **History** tab lists every change of state, newest first: when a session started waiting, how long it had been working before that, what it was running when it got stuck. Tick "Only what needed you" to see just the waits, hangs, and errors.

History is recorded only while the monitor is running, into `data/history.jsonl` (git-ignored, one JSON object per line, already redacted). Entries older than `history.retentionDays` are removed at startup. Set `history.enabled` to `false` to turn it off. Delete the file to clear it.

## Settings

Copy `config.example.json` to `config.json` and edit it. `config.json` is git-ignored. Every key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `thresholds.stuckToolMinutes` | 10 | A tool call running longer than this is "probably stuck" |
| `thresholds.stuckToolMinutesByTool` | `{ "task": 60 }` | Per-tool overrides |
| `thresholds.silentMinutes` | 10 | Silence from the model before "probably stuck". Raise it for slow local models |
| `lookbackHours` | 24 | Only sessions active in this window are listed |
| `contextLimit.models` | `{}` | Context window per `provider/model`, if it cannot be read from OpenCode's config |
| `redact.extraPatterns` | `[]` | Extra regular expressions to hide |
| `environment.modelServers` | `"local"` | Which model servers to check: `"local"`, `"all"`, or `"off"` |
| `environment.checkSeconds` | 15 | How often model servers and services are checked |
| `services` | `[]` | Extra things to watch: `{ "name", "url" }` or `{ "name", "host", "port" }` |
| `work.git` | `true` | Read the branch and recent commits of each project directory |
| `review.ignoreRules` | `[]` | Rules to leave out of "To review" |
| `work.protectedBranches` | `["main","master"]` | Warn when the agent changes files on these |
| `notify.environment` | `true` | Notify when an MCP server, model server, or service goes down |
| `history.retentionDays` | 30 | How long state changes are kept in `data/history.jsonl` |
| `notify.on` | `["waiting","stuck"]` | States that trigger a notification |
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
- The process list, to tell whether OpenCode is running.
- Each project directory: `.git/HEAD` is read for the branch, and `git log` for recent commits. `git status` is not used, because it would run filter programs named in the repository's own config; that is why uncommitted changes are not shown.
- HTTP or TCP checks against the model server and the services you configured.

## Limits

- **Tested with OpenCode 1.18.35 on Windows 11 (Node 24).** The test suite also runs on Linux and macOS with Node 22 and 24 in CI, against generated sample data. Running next to a real OpenCode on Linux or macOS, and desktop notifications there (`notify-send`, `osascript`), have not been tried yet. Reports welcome.
- OpenCode's database layout is not a public interface. The monitor checks the tables and columns it needs at startup and refuses to run if they are missing, but a subtler change could still produce wrong states.
- **Pending permission prompts are inferred.** OpenCode does not record the answer to a prompt, so the monitor treats a prompt as pending while the tool call it belongs to is still running and untouched. Two sessions prompting within the same two seconds could be confused.
- MCP status is inferred from failure lines in the log plus successful tool calls. With two OpenCode windows open, a failure logged by the older one can be missed.
- Secret detection in tool results reads only the first 8,000 characters of each result.
- Commits listed under Work are everything committed in that repository since the session started, whoever made them.
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
src/git.mjs             branch, status, commits per project
src/history.mjs         record of state changes (data/history.jsonl)
src/redact.mjs          secret patterns
src/notify.mjs          desktop and Discord notifications
src/process.mjs         is OpenCode running
src/opencode-config.mjs model limits, MCP names, model server addresses
public/                 the page
i18n/                   UI and notification strings (en, th)
scripts/make-sample.mjs fake data for --sample and the tests
```

To add a language, copy `i18n/en.json` to `i18n/<code>.json`, translate the values, and add the code to the `<select>` in `public/index.html` and `LANGS` in `public/app.js`.

```sh
npm test
```

## License

[MIT](LICENSE)
