# GitHub Buddy Server Setup Guide

This guide will help you set up the GitHub Buddy backend server for the Chrome extension.

## Prerequisites

- Node.js installed (any recent version)
- Git installed and on your PATH
- Claude CLI installed (`claude` on your PATH) — required for the agent features
- Git repositories to review

> **Platform note:** The server itself is plain Node.js and runs on macOS, Linux, and Windows.
> macOS/Linux use the `.command` bash launchers; **Windows users use the `.ps1` launchers and `Start Server.bat`** — see [Windows Setup](#windows-setup) below.

## Quick Setup

### 1. Configure Environment

Copy the example environment file and customize it:

```bash
cp .env.example .env
```

Edit `.env` and update these values:

```bash
# Find your Node.js path
which node

# Update .env with your actual values
NODE_PATH=/path/to/your/node                    # e.g., /opt/homebrew/bin/node
HTTP_PORT=13030                                  # HTTP server port
WS_PORT=13031                                    # WebSocket port
PROJECTS_DIR=/path/to/your/projects             # Where your git repos live
PR_REVIEWS_DIR=/path/to/questions and actions   # Where review files are stored
```

**Common Node.js locations:**
- Homebrew (Intel): `/usr/local/bin/node`
- Homebrew (Apple Silicon): `/opt/homebrew/bin/node`
- nvm: `~/.nvm/versions/node/vX.X.X/bin/node`

**Example configuration:**
```bash
NODE_PATH=/opt/homebrew/bin/node
HTTP_PORT=13030
WS_PORT=13031
PROJECTS_DIR=/Users/yourusername/Projects
PR_REVIEWS_DIR=/Users/yourusername/claude-github-buddy/questions and actions
```

### 2. Install Dependencies

```bash
cd server
npm install
cd ..
```

### 3. Test the Server

Start the server manually first to ensure everything works:

```bash
./launchers/start_server_daemon.command
```

You should see:
```
🤖 Starting GitHub Buddy Server (daemon mode)...
📍 Using Node.js: /path/to/node
🔌 HTTP Port: 13030, WebSocket Port: 13031
✅ Server started successfully (PID: xxxxx)
```

Visit http://localhost:13030 to confirm it's running.

### 4. Install Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `extension` directory from this project
5. The extension should now appear in your toolbar

### 5. Configure Extension

1. Click the extension icon
2. Go to Settings
3. Verify the server URL: `http://localhost:13030`
4. Update Projects Directory if needed (should match `.env`)

### 6. (Optional) Enable Auto-Start on Login

To have the server start automatically when you log in:

#### macOS (using launchd)

1. Create the launch agent plist:

```bash
mkdir -p ~/Library/LaunchAgents
```

2. Create `~/Library/LaunchAgents/com.yourusername.github-buddy-server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourusername.github-buddy-server</string>

    <key>ProgramArguments</key>
    <array>
        <string>/full/path/to/claude-github-buddy/launchers/start_server_daemon.command</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/full/path/to/claude-github-buddy/server/launchd.log</string>

    <key>StandardErrorPath</key>
    <string>/full/path/to/claude-github-buddy/server/launchd.error.log</string>

    <key>WorkingDirectory</key>
    <string>/full/path/to/claude-github-buddy</string>
</dict>
</plist>
```

3. Load the agent:

```bash
launchctl load ~/Library/LaunchAgents/com.yourusername.github-buddy-server.plist
```

**Note:** Replace `/full/path/to/claude-github-buddy` with the actual absolute path.

## Windows Setup

Windows can't run the `.command` bash scripts. Use the PowerShell launchers in `launchers\` and the double-click `Start Server.bat` instead. Everything else (config, the Chrome extension steps, ports) is identical.

### 1. Configure environment (optional)

`.env` is optional on Windows — the defaults already resolve correctly (`%USERPROFILE%\Projects`, HTTPS git). To override:

```powershell
Copy-Item .env.example .env
notepad .env
```

Windows-style values:

```
PROJECTS_DIR=C:\Users\yourusername\Projects
PR_REVIEWS_DIR=C:\Users\yourusername\Projects\claude-github-buddy\questions and actions
GIT_GITHUB_PROTOCOL=https
```

### 2. Install dependencies

```powershell
cd server
npm install
cd ..
```

(The launchers also auto-install on first run if `node_modules` is missing.)

### 3. Run the server

**Foreground** (a window stays open; close it to stop):

- Double-click **`Start Server.bat`**, or run `.\"Start Server.bat"` in a terminal.

**Background daemon** (PowerShell):

```powershell
.\launchers\start_server_daemon.ps1   # start in background
.\launchers\server_status.ps1         # check if running + port status
.\launchers\server_logs.ps1           # last 50 log lines
.\launchers\server_logs.ps1 100       # last 100 lines
.\launchers\server_logs.ps1 -Follow   # live tail
.\launchers\stop_server.ps1           # stop
```

Confirm it's up by visiting <http://localhost:13030/health> — you should see `{"status":"ok",...}`.

> **PowerShell execution policy:** if a script is blocked, either run it as
> `powershell -ExecutionPolicy Bypass -File .\launchers\start_server_daemon.ps1`,
> or allow local scripts once with
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### 4. Auto-start on login (optional)

Use Task Scheduler to run the daemon launcher at logon:

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\yourusername\Projects\claude-github-buddy\launchers\start_server_daemon.ps1"'
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'GitHubBuddyServer' -Action $action -Trigger $trigger
```

Then load the Chrome extension exactly as described in [step 4](#4-install-chrome-extension) and [step 5](#5-configure-extension) above.

---

## Configuration Priority

The server uses this priority for configuration (highest to lowest):

1. **Environment variables** (from `.env` file)
2. **config.json** (set via extension UI)
3. **Defaults** (in code)

This means `.env` takes precedence over UI settings, allowing you to lock certain values.

## Usage

### Manual Control

```bash
# Start server
./launchers/start_server_daemon.command

# Stop server
./launchers/stop_server.command

# Check status
./launchers/server_status.command

# View logs
./launchers/server_logs.command           # Last 50 lines
./launchers/server_logs.command -f         # Follow in real-time
./launchers/server_logs.command 100        # Last 100 lines
```

### launchd Control (if using auto-start)

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.yourusername.github-buddy-server.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.yourusername.github-buddy-server.plist

# Check status
launchctl list | grep github-buddy
```

## Configuration Reference

### .env Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_PATH` | Full path to Node.js binary | `$(which node)` |
| `HTTP_PORT` | HTTP server port | `13030` |
| `WS_PORT` | WebSocket server port | `13031` |
| `PROJECTS_DIR` | Root directory for git repositories | `~/Projects` |
| `PR_REVIEWS_DIR` | Directory for review files | `./questions and actions` |
| `GIT_GITHUB_PROTOCOL` | Git protocol for github.com | `ssh` |
| `GIT_GITHUB_SSH_KEY` | SSH key path for github.com | `~/.ssh/id_ed25519` |

### config.json (UI Settings)

The extension can create/update `server/config.json` via the Settings UI:

```json
{
  "prReviewsDir": "/path/to/reviews",
  "projectsDir": "/path/to/projects"
}
```

**Note:** `.env` variables take priority over `config.json`.

### Files to Keep Private

**Never commit these files to git:**
- `.env` - Your environment configuration
- `server/config.json` - UI-generated settings (may contain paths)
- `questions and actions/` - PR review files (user data)
- `server/server.pid` - Process ID file
- `server/server.log` - Server logs
- `server/launchd.log` - launchd stdout
- `server/launchd.error.log` - launchd stderr

These are already in `.gitignore`.

## Troubleshooting

### Server won't start

1. Check Node.js path is correct:
   ```bash
   cat .env | grep NODE_PATH
   # Then verify:
   /path/from/env --version
   ```

2. Check if ports are already in use:
   ```bash
   lsof -i :13030
   lsof -i :13031
   ```

3. Check logs for errors:
   ```bash
   ./server_logs.command
   ```

### Extension can't connect to server

1. Verify server is running:
   ```bash
   ./server_status.command
   ```

2. Check extension settings:
   - Server URL should be `http://localhost:13030`
   - Port should match `HTTP_PORT` in `.env`

3. Check browser console for errors (F12)

### Wrong projects directory

The extension uses this priority for finding projects:

1. `.env` → `PROJECTS_DIR`
2. `config.json` → `projectsDir`
3. Default: `~/Projects`

Update `.env` to lock the directory, or use extension Settings UI.

### Git operations failing

1. Verify git is available:
   ```bash
   git --version
   ```

2. Check SSH keys are configured (if using SSH):
   ```bash
   ssh -T git@github.com
   ```

3. Update git config in `.env`:
   ```bash
   GIT_GITHUB_PROTOCOL=https  # Use HTTPS instead of SSH
   ```

### launchd not starting server

1. Check launchd logs:
   ```bash
   cat server/launchd.error.log
   ```

2. Ensure paths in plist are absolute (not relative)

3. Test manual start first to isolate the issue

## Sleep/Wake Behavior

When you close your MacBook:
- Server processes are **suspended** (not terminated)
- On wake, processes **resume automatically**
- If server crashes during wake, launchd will restart it

This means the server should survive sleep/wake cycles in most cases.

## Port Conflicts

If ports 13030/13031 are in use by another service:

1. Choose new ports (e.g., 13032/13033)
2. Update `.env`:
   ```bash
   HTTP_PORT=13032
   WS_PORT=13033
   ```
3. Restart server
4. Update extension settings with new HTTP port

## Security Notes

- Server runs locally only - not accessible from network
- Review files may contain code from your repositories
- Git credentials are used from your system git config
- WebSocket connections are not encrypted (local only)

## Multi-User / Team Setup

To make this work for your team:

1. Each user copies `.env.example` to `.env`
2. Each user customizes their paths
3. Never commit `.env` or `config.json`
4. Share `.env.example` as template
5. Document any team-specific defaults in README

## Development

When working on this project:

1. Use `.env` for local overrides
2. Update `.env.example` when adding new config options
3. Test on a fresh clone to ensure setup works
4. Keep sensitive paths out of code - use config

## Common Workflows

### Changing projects directory

Option 1 - Via `.env` (recommended):
```bash
# Edit .env
PROJECTS_DIR=/new/path/to/projects

# Restart server
./launchers/stop_server.command && ./start_server_daemon.command
```

Option 2 - Via extension UI:
1. Click extension icon
2. Settings → Projects Directory
3. Save (creates/updates config.json)

### Changing ports

```bash
# Edit .env
HTTP_PORT=14030
WS_PORT=14031

# Restart server
./launchers/stop_server.command && ./start_server_daemon.command

# Update extension settings
# Settings → Server URL → http://localhost:14030
```

## Contributing

When sharing this project or contributing:

1. Never commit `.env`, `config.json`, or review files
2. Always use `.env.example` as a template
3. Document any new configuration options
4. Test on a fresh clone to ensure setup works
5. Update this SETUP.md with any new steps

## Support

For issues or questions:
1. Check logs: `./server_logs.command`
2. Try manual start to see detailed errors
3. Verify Node.js version: `node --version`
4. Check browser console for extension errors
5. Verify git credentials: `git config --list`
