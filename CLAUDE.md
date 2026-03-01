# CLAUDE.md — Claude GitHub Buddy

## Project Overview

Chrome extension that brings a Claude assistant directly into the "Files Changed" section of GitHub PRs. Highlights code, asks questions or marks sections for action, then Claude answers or implements changes. Features a real-time streaming log viewer in the browser.

**Type:** Chrome extension + local Node.js backend server
**Repo:** `git@github.com:trob9/claude-github-buddy.git`
**Runs on:** MacBook (not deployed on mini-pc / server)
**Not a web service** — this is a local dev tool, no Docker, no webhook deployment.

---

## Architecture

```
Chrome Extension (extension/)
  ↕ HTTP/WebSocket
Local Node.js Server (server/)
  ↕ subprocess
Claude Code CLI (claude)
  ↕ tools
Git repos on disk
```

The extension talks to the local server over HTTP (port 13030) and WebSocket (port 13031). The server spawns Claude Code CLI as a subprocess, streams its JSON output back to the browser.

---

## File Map

| File/Dir | Purpose |
|----------|---------|
| `extension/` | Chrome extension — manifest, content scripts, popup |
| `server/server.js` | HTTP server (Express) — receives requests from extension |
| `server/agent-server.js` | WebSocket server — streams Claude CLI output to browser |
| `server/git-helper.js` | Git utilities (clone, diff, PR context) |
| `server/config.js` | Loads config from `.env` |
| `server/package.json` | Node dependencies |
| `launchers/` | macOS `.command` files and launchd scripts |
| `Start Server.command` | Double-click to start server on macOS |
| `.env.example` | Template for environment config |
| `SETUP.md` | Full setup guide |

---

## Setup / Running

See `SETUP.md` for full instructions. Quick version:

```bash
cp .env.example .env
# Edit .env: NODE_PATH, HTTP_PORT (13030), WS_PORT (13031), PROJECTS_DIR, PR_REVIEWS_DIR

cd server && npm install

# Start server (foreground)
./Start\ Server.command

# Or daemon mode
./launchers/start_server_daemon.command
```

---

## Configuration (`.env`)

| Var | Purpose |
|-----|---------|
| `NODE_PATH` | Full path to node binary (`which node`) |
| `HTTP_PORT` | HTTP port (default: 13030) |
| `WS_PORT` | WebSocket port (default: 13031) |
| `PROJECTS_DIR` | Directory containing your git repos |
| `PR_REVIEWS_DIR` | Where question/action markdown files are saved |

**Never commit `.env`** — it's gitignored and contains local machine paths.

---

## Chrome Extension

Load unpacked extension from `extension/` in Chrome (`chrome://extensions/` → Developer mode → Load unpacked).

After loading, the extension appears in GitHub PR "Files Changed" tabs. It communicates with the local server — the server must be running for Claude features to work.

---

## Key Constraints

- **This is a local tool** — it runs on macOS, not on the mini-pc server. Don't try to Dockerize or deploy it.
- **Claude Code CLI must be installed** (`claude` binary in PATH) for the agent features to work.
- **The server runs on localhost** — the extension uses localhost URLs hardcoded in config. Don't change ports without updating both.
- **Questions/actions are saved to markdown files** in `PR_REVIEWS_DIR` for version control and review.
- **No database** — stateless beyond the markdown files written to disk.

---

## Logs

Server logs to stdout. If running as daemon, check the launcher script for log file location.
