# OpenCode Central

**English** · [ไทย](central.th.md)

One monitor for several machines. Each machine that runs OpenCode sends its figures to a hub, and the hub shows them all on one page and writes the key figures to InfluxDB. No text, code or file path ever leaves a machine. This lives on the branch `central`; everything in the main [README](../README.md) still applies to each machine on its own.

<a id="what"></a>

## What it is for

The monitor on its own answers "what is OpenCode doing on this machine". OpenCode Central answers "how is OpenCode doing on all my machines, and what changed when OpenCode, the model server or my settings changed". It keeps the times, token counts, states and versions of every session in one place, so that you (or Claude, later through MCP) can compare before and after a change and decide what to tune. It only shows and stores; it never changes OpenCode, its settings or a model server.

<a id="how"></a>

## How it works

```
 machine A ─┐                                      ┌─ page: every machine, a picker
 machine B ─┼─ agent (node server.mjs --agent) ──► │  hub (node server.mjs --central, Docker)
 machine C ─┘   reads opencode.db read-only,       ├─ one OpenCode-shaped SQLite file per machine
                strips all text, seals the batch,  └─ key figures → InfluxDB (optional)
                queues it on disk, POSTs /ingest
```

- **Agent** (`--agent`, on each machine that runs OpenCode): every 10 seconds it reads what changed in OpenCode's database (read-only; a locked database is a skipped cycle), plus what only the machine can see (is OpenCode running, its version, open permission prompts, project branches, the model limits in OpenCode's config). It removes every piece of text (see below), seals the batch to the hub's public key (X25519 + HKDF-SHA256 + AES-256-GCM), writes it to a queue on disk and sends it. A hub that cannot be reached never stops the agent: batches wait (up to 200 MB or 30 days) and are sent in order later. The first sync covers the last 30 days only (`central.sinceDays`).
- **Hub** (`--central`, normally in Docker): `POST /ingest` takes a batch from a machine that shows its own token, opens it, refuses it if any string still looks like text, and upserts the rows into `<dir>/machines/<machine>/opencode.db`, a file laid out like OpenCode's own. The unchanged monitor then runs on each of those files, so the page works as it does on one machine, with a machine picker. Rows are kept 180 days. When `central.influx` is set, each batch also becomes InfluxDB points.

<a id="data"></a>

## What leaves a machine

| Sent | Never sent |
| --- | --- |
| Times, durations, token counts (input, output, reasoning, cache), cost | Your prompts, the model's replies, its reasoning |
| Session state, tool and MCP server names, success or failure | What a tool printed, file contents, error messages |
| Model and provider names, model limits and compaction numbers | Commands, file paths, URLs, questions the agent asked you |
| OpenCode version, machine name, OS | Plan (todo) item text, permission patterns |
| Session title, the project folder's name (not its path), branch name | Keys, model server addresses, MCP start commands |

How: a whitelist. Only listed fields are copied; a field a future OpenCode adds is dropped. Text becomes filler (`·`) of the same length, so figures that count lengths still work. A tool's input becomes a keyed hash (HMAC-SHA256 with a key made on that machine), so the same call made twice is still seen as a loop. File paths become keyed hashes too. The hub checks every batch again and refuses one that still carries text.

Parts of the page that need text are not on the hub: Replay, "This machine", the files touched, the processes left running, flagged tool calls, plan items and command text. For those, run the normal monitor on the machine itself.

<a id="security"></a>

## Security model

- Machine → hub: each machine has its own token (only a SHA-256 of it is kept on the hub; making a new one revokes the old). `/ingest` is write-only: it answers `{"ok":true,"seq":n}` or `{"ok":false}` and nothing else. Wrong token 401, too big 413, broken or not content-free 400.
- Every batch is sealed to the hub's key, so a proxy that ends TLS on the way cannot read it.
- The page and its API need the monitor's access key (`lan: true`), as in the main README. `/health` and the token-checked `/ingest` are the only addresses open without it.
- The hub runs read-only, without Linux capabilities, as a non-root user. Its private key and the token hashes stay in its data volume.
- Never put a token, the hub's private key, the access key or a filled-in config into git, an issue or a chat.

<a id="requirements"></a>

## Requirements

- Hub: Docker with Compose (Docker Desktop on Windows is fine), one free TCP port (4317), and the machines able to reach it.
- Agent: Node.js 22.13 or newer and OpenCode on the same machine.
- Optional: InfluxDB 2.x with a bucket for the figures and a token that may only write to it.

<a id="hub"></a>

## Install the hub

<a id="hub-code"></a>

### 1. Get the code and the settings file

```sh
git clone --branch central https://github.com/adcident12/opencode-monitor
cd opencode-monitor/deploy/central
```

Create `data/config.json` (the folder `data/` is git-ignored) from `config.example.json`. Without InfluxDB, leave out `influx`:

```json
{
  "port": 4317,
  "lan": true,
  "pollMs": 5000,
  "notify": { "desktop": false },
  "history": { "file": "/data/history/history.jsonl", "retentionDays": 180 },
  "central": { "dir": "/data/central", "hosts": ["<hub LAN address>:4317"] }
}
```

`hosts` lists the names the hub is reached by from other machines (for example its LAN address with the port). A request under any other name is refused, which protects the page from DNS rebinding.

<a id="hub-keys"></a>

### 2. Build, make the keys, start

```sh
docker compose build
docker compose run --rm central --central-init
docker compose up -d
```

`--central-init` makes the hub's key pair once and prints its public key. The public key is not secret; every agent's config needs it. Check:

```sh
docker ps --filter name=opencode-central
curl http://127.0.0.1:4317/health
```

<a id="hub-firewall"></a>

### 3. Let the machines reach it

On a Windows host, Docker Desktop's published port is still blocked by Windows Firewall. In an administrator PowerShell, allow it from the local network only:

```powershell
New-NetFirewallRule -DisplayName "OpenCode Central hub (LAN only)" -Direction Inbound -Protocol TCP -LocalPort 4317 -RemoteAddress LocalSubnet -Action Allow -Profile Any
```

From another machine, `curl http://<hub LAN address>:4317/health` must answer `{"ok":true}`.

<a id="hub-token"></a>

### 4. A token for each machine

```sh
docker compose run --rm central --central-token <machine>
```

`<machine>` is 1 to 32 of `a-z`, `0-9` and `-`. The token is printed once; it goes into that machine's config and nowhere else. Running the command again for the same machine replaces (revokes) its token.

<a id="hub-influx"></a>

### 5. InfluxDB (optional)

Make a bucket (180 days) and a token that may only write to it, on the InfluxDB host:

```sh
influx bucket create --name opencode --retention 4320h --org <org>
influx auth create --org <org> --write-bucket <bucket id> --description "opencode-central hub (write only)"
```

Add to `central` in `data/config.json`, then `docker compose restart`:

```json
"influx": { "url": "http://<influxdb host>:8086", "org": "<org>", "bucket": "opencode", "token": "<write-only token>" }
```

Points (time = when it happened, in ns):

| Measurement | Tags | Fields |
| --- | --- | --- |
| `opencode_request` | machine, project, provider, model | tokens_in, tokens_out, reasoning, cache_read, cache_write, cost, duration_ms |
| `opencode_tool` | machine, project, tool, status | duration_ms |
| `opencode_compaction` | machine, project, auto | n |
| `opencode_state` | machine, project, from, to | seconds (time spent in the state left) |
| `opencode_version` | machine | version |

Points start when the hub first has `influx`; batches it took before are not written again.

<a id="agent"></a>

## Install an agent

On each machine that runs OpenCode:

```sh
git clone --branch central https://github.com/adcident12/opencode-monitor
cd opencode-monitor
```

Create `config.json` next to `server.mjs` (git-ignored):

```json
{
  "notify": { "desktop": false },
  "central": {
    "url": "http://<hub LAN address>:4317",
    "machine": "<machine>",
    "token": "<this machine's token>",
    "publicKey": "<the hub's public key>",
    "everyMs": 10000,
    "sinceDays": 30
  }
}
```

Start it once in a terminal to see it work, then stop it (Ctrl+C) and have it start at every login:

```sh
node server.mjs --agent
node server.mjs --agent --autostart on
```

On Windows, start the task now with `schtasks /Run /TN opencode-monitor`; on macOS and Linux `--autostart on` starts it at once. The agent keeps its state in `data/agent/` (the queue, the cursor, its hash key). The autostart task has the same name as the normal monitor's, so a machine runs the agent or the normal monitor at login, not both; the normal monitor can still be started by hand on another port (`node server.mjs --port 4318`).

<a id="check"></a>

## Check that it works

1. Use OpenCode on the machine for a minute.
2. On the hub: `docker logs opencode-central --tail 5` names the machine after a restart, and the machine has a folder under `data/central/machines/`.
3. Open `http://<hub LAN address>:4317/?key=<access key>` once (the key is in `data/history/access-key` on the hub); the page remembers it. Pick the machine at the top.
4. With InfluxDB: `from(bucket:"opencode") |> range(start:-1h)` shows `opencode_request` points for the machine.

On the agent: `data/agent/outbox/` should empty within seconds. Files that stay mean the hub is not reached; files in `data/agent/outbox/rejected/` were refused by the hub for good (too big or not content-free) and are kept for a look.

<a id="claude"></a>

## Setting it up with Claude Code

This page is written so that Claude Code on another machine can do the setup. Rules for the assistant doing it:

- Follow the sections above in order; check each step's result before the next.
- Never print, read back, commit or send in a chat: tokens, `data/central/hub-key.json`, `data/history/access-key`, a filled-in `config.json`. When a token is needed in a file, ask the owner to paste it into the file (or into a prompt on that machine) instead of passing it through the conversation.
- Commands that need administrator rights (the firewall rule) are run by the owner.
- Ask before replacing an existing `config.json` or an existing `opencode-monitor` autostart task.
- Report what was done and what is left, with the results of the checks in "Check that it works".

<a id="limits"></a>

## Limits

- Phase 1: the hub is meant for a local network. Reaching it from the internet (a reverse proxy that ends TLS at home, with its own login) is planned, not built.
- The hub has no MCP endpoint yet; MCP on each machine (`mcp.mjs`) still answers for that machine alone.
- Model server figures (llama.cpp) are not collected by the hub yet.
- A machine abroad behind a country filter, or offline, just queues; nothing is lost under the queue's cap.
- Deleting a session in OpenCode does not delete it on the hub; it ages out after 180 days.

<a id="troubleshooting"></a>

## Troubleshooting

- **`/health` works on the hub but not from other machines**: the firewall (see step 3).
- **The page answers 403**: the address you used is not in `central.hosts`.
- **No points in InfluxDB**: the hub logs `central: InfluxDB: …` when a write fails; no log line and no points means `influx` is missing from `central` in the config the container reads, or the hub was not restarted.
- **The agent says `central.<field> …`** at start: that setting is missing or invalid; the message says which.
- **A machine was reinstalled**: give it a new token; its queue starts a new instance and the hub counts its batches from 1 again.
