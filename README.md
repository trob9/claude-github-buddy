# Claude GitHub Buddy

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![Platforms: Windows | macOS](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-555)
![Built with Claude](https://img.shields.io/badge/built%20with-Claude-D97757)

A Chrome extension that brings a Claude assistant directly into the **Files changed** tab of GitHub PRs. Highlight code to ask Claude questions inline, mark sections for action, and let Claude answer or implement changes — all from your browser. Works on **Windows and macOS**, and (by default) uses your existing **Claude subscription** — no API key required.

## Features

- **Ask Questions** — highlight code in a PR diff and ask Claude about it
- **Mark for Action** — flag sections that need changes and give Claude instructions
- **Auto-Answer / Auto-Complete** — Claude answers every question or implements every action in one go
- **Inline display** — answers and actions render as GitHub-style comments in the PR
- **Markdown files** — questions/actions are saved to markdown for review and version control
- **Use your Claude subscription** — opens a live `claude` session on your machine (normal subscription usage), or use an API key / Vertex if you prefer
- **Works on the new "Files changed" experience** and the legacy diff view

## Screenshots
<img width="679" height="154" alt="image" src="https://github.com/user-attachments/assets/b7d1162c-45e8-4b26-ac1b-47b1fbd93c69" />
<img width="622" height="153" alt="image" src="https://github.com/user-attachments/assets/3ce5e022-4846-4605-bca4-4f2299612b0d" />
<img width="460" height="408" alt="image" src="https://github.com/user-attachments/assets/b6dcad32-842f-452e-9c48-d19d39ec5875" />
<img width="545" height="411" alt="image" src="https://github.com/user-attachments/assets/58caaebb-d74c-4daf-a89d-4cef38a0fb10" />
<img width="925" height="246" alt="image" src="https://github.com/user-attachments/assets/22f39319-cd24-41d8-8113-e2c52176b572" />

## Prerequisites

- **Node.js** (v18+), **git**, and the **`claude` CLI** on your PATH (`claude --version` should work)
- A GitHub account signed in to Chrome/Edge/Brave/Opera

## Quick Start

No `.env` is needed — the defaults work out of the box.

### 1. Install server dependencies

```bash
cd server
npm install
cd ..
```

### 2. Start the server

**macOS** — double-click **`Start Server.command`**, or run a launcher:
```bash
./launchers/start_server_daemon.command   # background daemon
./launchers/stop_server.command           # stop
./launchers/server_status.command         # status
./launchers/server_logs.command           # logs
```

**Windows** — double-click **`Start Server.bat`** (foreground), or use the PowerShell daemon:
```powershell
.\launchers\start_server_daemon.ps1   # background daemon
.\launchers\stop_server.ps1           # stop
.\launchers\server_status.ps1         # status
.\launchers\server_logs.ps1           # logs
```
> If PowerShell blocks a script, run it once as
> `powershell -ExecutionPolicy Bypass -File .\launchers\start_server_daemon.ps1`,
> or allow local scripts: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

The server listens on **`http://localhost:47382`** (HTTP) and **`ws://localhost:47383`** (WebSocket) — these match the extension, so nothing to configure. Confirm with <http://localhost:47382/health>.

### 3. Load the extension

1. Open `chrome://extensions/` (or `edge://extensions/`)
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `extension/` folder

### 4. (Optional) Settings

Open **Settings** from the extension's dropdown to choose your **native Claude setup** (see below), set the autonomy toggle, and point at your Projects / review-files directories. Everything has a sensible default.

## How Claude runs ("native Claude setup")

Pick this in the extension's Settings. It controls what happens when you click **Answer Questions** / **Start Actions**:

| Mode | What it does | Billing |
|---|---|---|
| **Claude subscription — live window** (default) | Opens a real interactive `claude` window you can watch and steer | Counts as **normal subscription usage** |
| **Claude subscription — `claude -p`** | Runs headless `claude -p` in a window that closes when done | **API-rate** Agent-SDK credit ([details](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)) |
| **Anthropic API key** | Headless Agent SDK, streamed to the in-browser panel | Pay-as-you-go to `ANTHROPIC_API_KEY` |
| **Google Vertex AI** | Headless Agent SDK via Vertex | Your GCP Vertex billing |

**Autonomy:** the live window usually needs `--dangerously-skip-permissions` to work hands-off (otherwise Claude pauses for tool approval in its terminal). Toggle it permanently in Settings, or approve it per-run when prompted.

## Usage

> Tip: **Unified** diff view gives Claude the best context (Split works too).

- **Ask:** hover/select code in the diff → click the Claude icon → type a question → Save. Or use the dropdown → **Ask Claude**.
- **Mark for Action:** dropdown → **Mark for Action** → give instructions.
- **Answer Questions / Start Actions:** the buttons in the PR toolbar run Claude over everything you've saved; results refresh inline.
- **Repo location:** the first time, if your local clone isn't in your Projects directory, you'll be asked to point at it or have Claude clone it (remembered per-repo).
- **Stuck?** the dropdown has **Reset Claude state (unstick buttons)**.

## Configuration

Everything is optional and lives in `.env` (copy from `.env.example`). Most people never need it. Notable vars:

- `HTTP_PORT` / `WS_PORT` — default **47382 / 47383** (must match the extension if changed)
- `NODE_PATH` — only used by the daemon launchers; defaults to `node` on PATH
- `PROJECTS_DIR` — where repos are cloned/found (default `<home>/Projects`)
- `PR_REVIEWS_DIR` — where question/action markdown is stored
- `CLAUDE_RUN_MODE` (`interactive`|`print`|`sdk`|`vertex`), `CLAUDE_SKIP_PERMISSIONS=1` — usually set via the Settings UI instead
- `ANTHROPIC_API_KEY` (sdk mode), `CLAUDE_CODE_USE_VERTEX=1` + project/region (vertex mode)
- `GIT_GITHUB_PROTOCOL` — `https` (default) or `ssh`

Priority: `.env` > `server/config.json` (Settings UI) > defaults.

## File structure

```
claude-github-buddy/
├── extension/                 # Chrome extension (manifest, content scripts, styles, icons)
├── server/
│   ├── server.js              # HTTP server + endpoints
│   ├── agent-server.js        # Agent SDK (sdk/vertex) + WebSocket
│   ├── interactive-runner.js  # opens the live/`-p` Claude terminal window
│   ├── git-helper.js          # clone/checkout/diff
│   └── config.js              # configuration
├── launchers/                 # .command (macOS) + .ps1 (Windows) start/stop/status/logs
├── Start Server.command       # macOS double-click (foreground)
├── Start Server.bat           # Windows double-click (foreground)
└── questions and actions/     # generated markdown (gitignored)
```

## Server API

`POST /writeFile` · `POST /readFile` · `GET /listFiles` · `POST /deleteFile` · `POST /archiveFile` · `GET /getConfig` · `POST /updateConfig` · `GET /getDefaultConfig` · `POST /checkRepo` · `POST /runInteractive` · `POST /startSession` · `POST /answerQuestions` · `POST /completeActions` · `GET /health`

## Troubleshooting

**Server won't start / "port already in use"** — it's probably already running; stop it first (`stop_server` launcher). To check the port:
```bash
# macOS
lsof -i :47382
```
```powershell
# Windows
Get-NetTCPConnection -LocalPort 47382 -State Listen
```

**Extension can't reach the server** — confirm <http://localhost:47382/health> returns `{"status":"ok"}` and that the server is running. The extension and server both use 47382/47383 by default.

**"`claude` CLI not found"** — install Claude Code and make sure `claude --version` works in a terminal, then restart the server.

**Live window opens then closes immediately** — usually a `claude` auth issue; run `claude` once in a terminal to confirm you're signed in.

## Security notes

- Server runs locally only (`localhost`); nothing is sent anywhere except to Claude
- Questions/actions are stored locally as markdown
- Agent runs only on an explicit button click
- The git workflow never force-resets a dirty tree — it stashes or stops rather than discard your local work

## Contributing

1. Don't commit `.env` or `server/config.json` (already gitignored)
2. Update `.env.example` if you add config options
3. Test on a fresh clone on both Windows and macOS where possible

## Credits

Built with the [Anthropic Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview), Chrome Extensions Manifest V3, and GitHub Primer CSS.

## License

MIT
