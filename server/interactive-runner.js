/**
 * interactive-runner.js — open a Claude terminal window on this machine for
 * users who are NOT on Anthropic-API / Vertex billing.
 *
 * Two distinct modes (they bill differently — this is the whole point):
 *
 *   mode = 'interactive'  → opens a REAL interactive `claude` window (NO -p).
 *     Anthropic treats this as normal Claude Code subscription usage. The
 *     window stays open; you can watch and steer it. It does not auto-close.
 *
 *   mode = 'print'        → runs `claude -p` (headless/print). Per Anthropic's
 *     billing, -p / Agent-SDK usage draws from the separate Agent-SDK credit
 *     (API rates), NOT your interactive subscription allowance. The window
 *     auto-closes when the task finishes.
 *     https://support.claude.com/en/articles/15036540
 *
 * Why a launcher SCRIPT instead of one big spawn arg: passing a long multi-line
 * prompt through `cmd /c start ...` is a quoting nightmare. Instead we write the
 * full prompt to a temp file and a tiny launcher script that either pipes that
 * file into `claude -p` (print) or starts interactive `claude` seeded with a
 * short, quote-safe instruction to read that file. We control every byte of the
 * launcher, so there's no shell-quoting risk. No tmux, no send-keys, no WSL.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

/**
 * Is the `claude` CLI actually on PATH? Without this check the new terminal
 * window would flash "'claude' is not recognized" and close, while the server
 * still reports launched:true and the UI hangs for 15 minutes polling a file
 * that never changes. Probe once and cache the result.
 */
let _claudeAvailable = null;
export function isClaudeAvailable() {
  if (_claudeAvailable !== null) return _claudeAvailable;
  try {
    // shell:true so Windows resolves claude.cmd/.ps1 on PATH like a terminal would.
    const r = spawnSync('claude', ['--version'], { shell: true, timeout: 10000 });
    _claudeAvailable = r.status === 0;
  } catch {
    _claudeAvailable = false;
  }
  return _claudeAvailable;
}

/**
 * @param {object} opts
 * @param {string} opts.prompt              Full prompt / instructions for Claude.
 * @param {string} opts.cwd                 Working directory (the prepared repo).
 * @param {'interactive'|'print'} opts.mode How to run Claude (see file header).
 * @param {boolean} [opts.skipPermissions]  Start Claude with
 *        --dangerously-skip-permissions so it acts autonomously without
 *        stopping to ask for tool approval.
 * @param {string} [opts.title]             Window title.
 * @returns {{ launched: boolean, mode: string, promptFile: string, platform: string }}
 */
export function launchInteractiveClaude({ prompt, cwd, mode = 'interactive', skipPermissions = false, title = 'Claude GitHub Buddy' }) {
  const stamp = Date.now();
  // os.tmpdir() is normally space-free (e.g. C:\Users\<u>\AppData\Local\Temp),
  // which keeps the seed instruction quote-safe below.
  const promptFile = path.join(os.tmpdir(), `gh-buddy-prompt-${stamp}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const platform = process.platform;
  let child;

  // The autonomy flag, inserted into every claude invocation below when on.
  const skipFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';

  // The short, quote-safe instruction used in INTERACTIVE mode — the real
  // instructions live in promptFile so we never pass the big prompt as an arg.
  const seed = `Read the file ${quoteForClaudeArg(promptFile)} and follow its instructions exactly. When everything is complete you can close this window.`;

  if (platform === 'win32') {
    const scriptFile = path.join(os.tmpdir(), `gh-buddy-launch-${stamp}.cmd`);
    const lines = ['@echo off', 'chcp 65001>nul', `cd /d "${cwd}"`];
    if (mode === 'print') {
      // Pipe the prompt file into headless claude; window closes when it exits.
      lines.push(`claude -p${skipFlag} 0< "${promptFile}"`);
    } else {
      // Interactive claude seeded with the read-this-file instruction.
      lines.push(`claude${skipFlag} "${seed}"`);
    }
    fs.writeFileSync(scriptFile, lines.join('\r\n') + '\r\n', 'utf8');

    // start opens a new console; /c closes it when done (print), /k keeps it
    // (interactive — though interactive claude keeps the window alive anyway).
    const keepFlag = mode === 'print' ? '/c' : '/k';
    child = spawn('cmd.exe', ['/c', 'start', title, 'cmd', keepFlag, scriptFile], {
      cwd, detached: true, stdio: 'ignore', windowsHide: false,
    });
    scheduleCleanup([promptFile, scriptFile]);
  } else if (platform === 'darwin') {
    const inner = mode === 'print'
      ? `cd ${shq(cwd)}; claude -p${skipFlag} < ${shq(promptFile)}; exit`
      : `cd ${shq(cwd)}; claude${skipFlag} ${shq(seed)}`;
    const script = `tell application "Terminal" to do script ${shq(inner)}`;
    child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    scheduleCleanup([promptFile]);
  } else {
    const inner = mode === 'print'
      ? `cd ${shq(cwd)}; claude -p${skipFlag} < ${shq(promptFile)}`
      : `cd ${shq(cwd)}; claude${skipFlag} ${shq(seed)}`;
    const terminals = [
      ['x-terminal-emulator', ['-e', `bash -lc ${shq(inner)}`]],
      ['gnome-terminal', ['--', 'bash', '-lc', inner]],
      ['konsole', ['-e', `bash -lc ${shq(inner)}`]],
      ['xterm', ['-e', `bash -lc ${shq(inner)}`]],
    ];
    child = trySpawnFirst(terminals, cwd);
    if (!child) {
      // No GUI terminal — fall back to headless so the task still runs.
      child = spawn('bash', ['-lc', inner], { cwd, detached: true, stdio: 'ignore' });
    }
    scheduleCleanup([promptFile]);
  }

  if (child) child.unref();
  return { launched: !!child, mode, skipPermissions, promptFile, platform };
}

// Quote a path for embedding inside the interactive seed string. The seed is
// wrapped in double quotes by the launcher, so single-quote the path; if it's
// space-free we can leave it bare (cleanest for Claude to read).
function quoteForClaudeArg(p) {
  return /\s/.test(p) ? `'${p}'` : p;
}

// POSIX single-quote escape.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function trySpawnFirst(candidates, cwd) {
  for (const [cmd, args] of candidates) {
    try {
      const c = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
      c.on('error', () => {});
      return c;
    } catch { /* try next */ }
  }
  return null;
}

function scheduleCleanup(files) {
  setTimeout(() => {
    for (const f of files) fs.promises.unlink(f).catch(() => {});
  }, 15 * 60 * 1000);
}
