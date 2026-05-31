#!/usr/bin/env node

/**
 * Claude GitHub Buddy - Local HTTP Server
 * Handles file operations AND Claude API calls for the Chrome extension
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createSession, answerQuestionsWithAgent, completeActionsWithAgent } from './agent-server.js';
import { config, reloadConfig } from './config.js';
import { getOrCloneRepo } from './git-helper.js';
import { launchInteractiveClaude, isClaudeAvailable } from './interactive-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = config.httpPort;

/**
 * For the headless SDK paths, check the chosen billing credentials exist so the
 * user gets a clear message instead of a raw SDK auth error (audit finding #2).
 * Returns an error string, or null if OK.
 */
function sdkCredentialError() {
  if (config.runMode === 'sdk' && !process.env.ANTHROPIC_API_KEY) {
    return 'Run mode is "Anthropic API key" but ANTHROPIC_API_KEY is not set in the server environment. Set it in .env, or switch mode in Settings.';
  }
  if (config.runMode === 'vertex' && process.env.CLAUDE_CODE_USE_VERTEX !== '1') {
    return 'Run mode is "Google Vertex" but Vertex is not configured (CLAUDE_CODE_USE_VERTEX/project/region). Configure it in .env, or switch mode in Settings.';
  }
  return null;
}

/**
 * Build the prompt for the visible `claude -p` interactive window. It mirrors
 * the SDK path's intent (answer questions / complete actions by editing the
 * tracking markdown file at its absolute path, reviewing committed PR code),
 * condensed for one-shot headless execution that exits when done.
 */
function buildInteractivePrompt({ kind, repoStatus, prInfo, trackingFile, useUltrathink }) {
  const branch = prInfo.headBranch;
  const repoPath = repoStatus.path;
  const ut = useUltrathink ? 'IMPORTANT: Ultrathink for this task. Use extended thinking.\n\n' : '';

  // Only emit git checkout/reset steps when we actually know the PR branch.
  // Otherwise we'd tell Claude to do destructive nonsense like
  // `git reset --hard origin/unknown`. `pr <n>` checkout via gh is the safe
  // fallback that doesn't depend on the branch name.
  const branchKnown = branch && branch !== 'unknown';

  // When the user told us the repo isn't installed, instruct Claude to clone
  // it into the projects dir first. ${repoPath} here is <projectsDir>/<repo>.
  const cloneCmd = branchKnown
    ? `git clone https://github.com/${prInfo.fullRepoName}.git "${repoPath}" && cd "${repoPath}" && git checkout ${branch}`
    : `git clone https://github.com/${prInfo.fullRepoName}.git "${repoPath}" && cd "${repoPath}" && gh pr checkout ${prInfo.prNumber}`;

  const prep = repoStatus.needsClone
    ? `The repository is NOT yet on this machine. Clone it into the projects directory first, then work inside it:\n  ${cloneCmd}\n(If the PR is already merged, a plain clone of the default branch is fine.)`
    : repoStatus.prepared
      ? `The repository is ready at ${repoPath} with branch '${branch}' checked out and pulled.`
      : branchKnown
        ? `Repository auto-prep had an issue (${repoStatus.error || 'unknown'}). First, inside ${repoPath}: git fetch --all && git checkout ${branch} && git pull.`
        : `Repository auto-prep had an issue (${repoStatus.error || 'unknown'}) and the PR branch could not be determined automatically. Inside ${repoPath}, check out the PR by number instead: gh pr checkout ${prInfo.prNumber} (this fetches and switches to PR #${prInfo.prNumber}'s code regardless of branch name). If the PR is already merged, that's fine - just review the current state.`;

  // SAFETY: this runs inside the user's REAL clone, which may hold uncommitted
  // work or local commits. We must never destroy that. The old flow did a
  // `git reset --hard origin/<branch>` guarded only by a stash — if the stash
  // was skipped/failed, or there were untracked files, that silently nuked the
  // user's work. The new flow refuses to touch a dirty tree and never hard-
  // resets; it uses a read-only checkout + ff-only pull, and tells Claude to
  // STOP rather than force anything if the tree isn't clean.
  const reviewBlock = (branchKnown && !repoStatus.needsClone)
    ? `Get onto the PR's committed code WITHOUT destroying any local work:
1. Run 'git status --porcelain'. If it prints ANYTHING, the working tree is dirty:
   - DO NOT run any destructive command (no 'git reset --hard', no 'git checkout -f', no 'git clean').
   - Try 'git stash push -u -m "gh-buddy: WIP before PR review"'. Re-run 'git status --porcelain'; if it's now empty, remember to 'git stash pop' at the very end.
   - If it is STILL not clean (stash failed), STOP and write a note in the tracking file that the repo had uncommitted changes you wouldn't overwrite. Do not proceed.
2. With a clean tree: 'git fetch origin' then 'git checkout ${branch}' then 'git merge --ff-only origin/${branch}'.
   - If the fast-forward merge fails (local commits diverge), DO NOT force it. Just review the code as-is and note the divergence in the tracking file.
3. `
    : `Make sure you're looking at the PR's code (see the note above). Never run destructive git commands ('reset --hard', 'checkout -f', 'clean') against a dirty tree - if 'git status --porcelain' isn't empty, stash with '-u' or stop and note it. Then `;

  // Shared do-no-harm preamble for both kinds.
  const safety = `IMPORTANT - protect the user's work: this is their real local clone. Never discard uncommitted changes, untracked files, or un-pushed commits. If anything is unclear or a git step would be destructive, STOP and explain in the tracking file instead of forcing it.\n\n`;

  if (kind === 'questions') {
    return `${ut}${safety}You are answering questions about a GitHub PR review.

${prep}

Two separate locations:
1. CODE REPOSITORY: ${repoPath} (your working directory) - read code here to answer.
2. QUESTIONS FILE: ${trackingFile} - edit THIS file (absolute path) to add answers. Never copy it into the repo.

${reviewBlock}read the questions file and answer every question by filling its ANSWER sections (edit ${trackingFile}). Answering only reads code, so even if the tree couldn't be updated you can still answer against the current state - just say so.${branchKnown ? '\nIf you stashed earlier, run \'git stash pop\' when finished.' : ''}

When every question has a complete ANSWER, you are done - stop.`;
  }

  return `${ut}${safety}You are completing actions for a GitHub PR review.

${prep}

Two separate locations:
1. CODE REPOSITORY: ${repoPath} (your working directory) - make changes, run tests, commit, push here.
2. ACTIONS FILE: ${trackingFile} - edit THIS file (absolute path) to fill SUMMARY sections. Never commit it to the repo.

Git workflow (never destroy local work):
1. Run 'git status --porcelain'. If it's NOT empty, stash with 'git stash push -u -m "gh-buddy: WIP before PR review actions"'. If it still isn't clean, STOP and note it in the tracking file - do not overwrite the user's changes.
2. Make the requested changes on the PR branch, run tests if relevant, commit with a clear message, then 'git push'. If push is rejected, do NOT force-push - note the rejection in the tracking file.
3. After a successful push, if you stashed in step 1, run 'git stash pop'.
4. Fill in the SUMMARY for every action by editing ${trackingFile}.

When every action has a complete SUMMARY, you are done - stop.`;
}

// Ensure directory exists
if (!fs.existsSync(config.prReviewsDir)) {
  fs.mkdirSync(config.prReviewsDir, { recursive: true });
}

console.log('🤖 Claude GitHub Buddy Server');
console.log('==============================');
console.log(`📁 Saving files to: ${config.prReviewsDir}`);
console.log(`🌐 Server running at: http://localhost:${PORT}`);
console.log('✅ Ready! Keep this running while using the extension.');
console.log('');

const server = http.createServer((req, res) => {
  // CORS headers for Chrome extension
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Parse request
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');

      if (req.url === '/writeFile' && req.method === 'POST') {
        const filePath = path.join(config.prReviewsDir, data.filename);

        // Create nested directories if they don't exist
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          console.log(`📁 Created directory: ${path.relative(config.prReviewsDir, dir)}`);
        }

        fs.writeFileSync(filePath, data.content, 'utf8');
        console.log(`✅ Wrote: ${data.filename}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filePath }));
        return;
      }

      if (req.url === '/readFile' && req.method === 'POST') {
        console.log('[SERVER] readFile request received');
        console.log('[SERVER] data.filename:', data.filename);
        const filePath = path.join(config.prReviewsDir, data.filename);
        console.log('[SERVER] Full path:', filePath);
        console.log('[SERVER] File exists?', fs.existsSync(filePath));

        if (!fs.existsSync(filePath)) {
          console.log('[SERVER] ❌ File not found:', filePath);
          // List what files DO exist in the directory
          const dir = path.dirname(filePath);
          if (fs.existsSync(dir)) {
            console.log('[SERVER] Directory exists. Files in directory:');
            const filesInDir = fs.readdirSync(dir);
            filesInDir.forEach(f => console.log(`  - ${f}`));
          } else {
            console.log('[SERVER] Directory does not exist:', dir);
          }
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'File not found' }));
          return;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        console.log(`[SERVER] ✅ Successfully read: ${data.filename} (${content.length} bytes)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, content }));
        return;
      }

      if (req.url === '/listFiles' && req.method === 'GET') {
        const files = fs.readdirSync(config.prReviewsDir)
          .filter(f => f.endsWith('.md'))
          .map(f => ({
            name: f,
            path: path.join(config.prReviewsDir, f),
            modified: fs.statSync(path.join(config.prReviewsDir, f)).mtime
          }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, files }));
        return;
      }

      if (req.url === '/deleteFile' && req.method === 'POST') {
        console.log('[SERVER] deleteFile request received');
        const filePath = path.join(config.prReviewsDir, data.filename);
        console.log('[SERVER] File to delete:', filePath);

        if (!fs.existsSync(filePath)) {
          console.log('[SERVER] ❌ File not found for deletion:', filePath);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'File not found' }));
          return;
        }

        try {
          fs.unlinkSync(filePath);
          console.log('🗑️  File deleted:', data.filename);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          console.error('❌ Error deleting file:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
      }

      if (req.url === '/archiveFile' && req.method === 'POST') {
        console.log('[SERVER] archiveFile request received');
        const filePath = path.join(config.prReviewsDir, data.filename);
        console.log('[SERVER] Source file:', filePath);

        if (!fs.existsSync(filePath)) {
          console.log('[SERVER] ❌ File not found for archiving:', filePath);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'File not found' }));
          return;
        }

        // Create archive directory in the same folder as the file
        const fileDir = path.dirname(filePath);
        const archiveDir = path.join(fileDir, 'archive');
        if (!fs.existsSync(archiveDir)) {
          fs.mkdirSync(archiveDir, { recursive: true });
          console.log(`📁 Created archive directory: ${path.relative(config.prReviewsDir, archiveDir)}`);
        }

        // Create archive filename with timestamp
        const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
        const fileName = path.basename(filePath);
        const archiveFileName = fileName.replace(/\.md$/, `_${timestamp}.md`);
        const archivePath = path.join(archiveDir, archiveFileName);

        // Copy file to archive
        fs.copyFileSync(filePath, archivePath);
        console.log(`📦 Archived: ${data.filename} → archive/${archiveFileName}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, archivePath: path.relative(config.prReviewsDir, archivePath) }));
        return;
      }

      if (req.url === '/startSession' && req.method === 'POST') {
        // Create a new Agent SDK session and return sessionId
        const sessionId = createSession();
        console.log(`[SESSION] Created new session: ${sessionId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, sessionId }));
        return;
      }

      if (req.url === '/answerQuestions' && req.method === 'POST') {
        console.log('[AGENT] Processing answer questions request...');
        const { sessionId, prInfo, useUltrathink } = data;

        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing sessionId' }));
          return;
        }

        const credErr = sdkCredentialError();
        if (credErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: credErr }));
          return;
        }

        // Build file path to questions file
        const repoName = prInfo.fullRepoName.split('/')[1];
        const prFolder = `PR-${prInfo.prNumber}`;
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;
        const filePath = path.join(config.prReviewsDir, filename);

        // Use Agent SDK to answer questions
        answerQuestionsWithAgent(sessionId, prInfo, filePath, useUltrathink)
          .then(result => {
            // Parse result and update markdown file
            // (For now, Claude updates via tools directly)
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
          })
          .catch(error => {
            console.error('❌ Error answering questions:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
          });
        return;
      }

      if (req.url === '/completeActions' && req.method === 'POST') {
        console.log('[AGENT] Processing complete actions request...');
        const { sessionId, prInfo, useUltrathink } = data;

        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing sessionId' }));
          return;
        }

        const credErr2 = sdkCredentialError();
        if (credErr2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: credErr2 }));
          return;
        }

        // Build file path to actions file
        const repoName = prInfo.fullRepoName.split('/')[1];
        const prFolder = `PR-${prInfo.prNumber}`;
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;
        const filePath = path.join(config.prReviewsDir, filename);

        // Use Agent SDK to complete actions
        completeActionsWithAgent(sessionId, prInfo, filePath, useUltrathink)
          .then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
          })
          .catch(error => {
            console.error('❌ Error completing actions:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
          });
        return;
      }

      if (req.url === '/getConfig' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          config: {
            prReviewsDir: config.prReviewsDir,
            projectsDir: config.projectsDir,
            runMode: config.runMode,
            skipPermissions: config.skipPermissions
          }
        }));
        return;
      }

      if (req.url === '/getDefaultConfig' && req.method === 'GET') {
        // Return default values (what they would be without config.json)
        const defaults = {
          prReviewsDir: path.join(dirname(__dirname), 'questions and actions'),
          projectsDir: path.join(os.homedir(), 'Projects')
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          defaults: defaults
        }));
        return;
      }

      if (req.url === '/updateConfig' && req.method === 'POST') {
        console.log('[SERVER] updateConfig request received');
        const { prReviewsDir, projectsDir, runMode, skipPermissions } = data;

        // Validate the Projects directory exists before saving — a typo'd or
        // moved path would otherwise silently break every clone/launch later.
        // (prReviewsDir is allowed to not exist yet; we create it. But it must
        // be creatable — reject if its parent is missing.)
        if (projectsDir && !fs.existsSync(projectsDir)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Projects directory does not exist:\n${projectsDir}` }));
          return;
        }
        if (prReviewsDir) {
          const parent = path.dirname(prReviewsDir);
          if (!fs.existsSync(prReviewsDir) && !fs.existsSync(parent)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Questions & Actions directory can't be created — its parent folder doesn't exist:\n${parent}` }));
            return;
          }
        }

        try {
          // Merge into existing config.json so a runMode-only save (from the
          // "native Claude setup" picker) doesn't wipe the saved directories,
          // and vice-versa.
          const configPath = path.join(__dirname, 'config.json');
          let existing = {};
          if (fs.existsSync(configPath)) {
            try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
          }
          const newConfig = { ...existing };
          if (prReviewsDir) newConfig.prReviewsDir = prReviewsDir;
          if (projectsDir) newConfig.projectsDir = projectsDir;
          if (runMode) {
            let m = String(runMode).toLowerCase();
            if (m === 'subscription') m = 'interactive'; // back-compat
            if (['interactive', 'print', 'sdk', 'vertex'].includes(m)) newConfig.runMode = m;
          }
          if (typeof skipPermissions === 'boolean') {
            newConfig.skipPermissions = skipPermissions;
          }
          fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');

          // Reload configuration
          const reloaded = reloadConfig();

          if (reloaded) {
            console.log('✅ Configuration updated:', newConfig);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, config: { ...newConfig, runMode: config.runMode } }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Failed to reload config' }));
          }
        } catch (error) {
          console.error('❌ Error updating config:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
      }

      // Detect whether the repo already exists on disk, so the browser dialog
      // can ask the user (point at an existing clone, or clone it fresh).
      if (req.url === '/checkRepo' && req.method === 'POST') {
        const { fullRepoName } = data;
        if (!fullRepoName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing fullRepoName' }));
          return;
        }
        const repoName = fullRepoName.split('/').pop();
        const remembered = config.repoPaths[fullRepoName];
        const defaultPath = path.join(config.projectsDir, repoName);

        const isGitRepo = (p) => !!p && fs.existsSync(p) && fs.existsSync(path.join(p, '.git'));

        let found = null;
        if (isGitRepo(remembered)) found = remembered;
        else if (isGitRepo(defaultPath)) found = defaultPath;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          exists: !!found,
          path: found,                 // where it was found (null if not)
          defaultPath,                 // where we'd clone it if not installed
          projectsDir: config.projectsDir,
          remembered: isGitRepo(remembered) ? remembered : null
        }));
        return;
      }

      // Subscription / interactive mode: open a Claude window that does the work.
      // No API/Vertex, no monitor panel.
      if (req.url === '/runInteractive' && req.method === 'POST') {
        console.log('[INTERACTIVE] runInteractive request received');
        // repoPath: optional explicit location of an existing clone the user
        //   pointed us at. rememberPath: persist that mapping for next time.
        // notInstalled: user said it's not on disk -> instruct Claude to clone.
        const { prInfo, kind, useUltrathink, skipPermissions, repoPath, rememberPath, notInstalled } = data;
        const useSkip = (typeof skipPermissions === 'boolean') ? skipPermissions : config.skipPermissions;

        if (!prInfo || !prInfo.fullRepoName || (kind !== 'questions' && kind !== 'actions')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing prInfo or invalid kind' }));
          return;
        }

        // Guard: the `claude` CLI must be on PATH, else the window flashes an
        // error and closes while the UI hangs for 15 min (audit finding #1).
        if (!isClaudeAvailable()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'The `claude` CLI was not found on PATH. Install Claude Code and make sure `claude --version` works in a terminal.' }));
          return;
        }

        // Guard: a user-supplied repo path must actually exist and be a git
        // repo (audit: validate provided path before launching).
        if (repoPath) {
          if (!fs.existsSync(repoPath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `That path doesn't exist:\n${repoPath}` }));
            return;
          }
          if (!fs.existsSync(path.join(repoPath, '.git'))) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `That folder isn't a git repository (no .git found):\n${repoPath}` }));
            return;
          }
        }

        (async () => {
          // Remember a user-supplied path for this repo, if asked.
          if (repoPath && rememberPath) {
            config.repoPaths[prInfo.fullRepoName] = repoPath;
            try {
              const cfgPath = path.join(__dirname, 'config.json');
              let existing = {};
              if (fs.existsSync(cfgPath)) { try { existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {} }
              existing.repoPaths = { ...(existing.repoPaths || {}), [prInfo.fullRepoName]: repoPath };
              fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf8');
            } catch (e) { console.error('[INTERACTIVE] Could not persist repo path:', e.message); }
          }

          // Resolve where this repo should live: explicit path > remembered >
          // default <projectsDir>/<repo>.
          const repoName = prInfo.fullRepoName.split('/')[1];
          const resolvedPath = repoPath || config.repoPaths[prInfo.fullRepoName] ||
                               path.join(config.projectsDir, repoName);

          // If the user said it's not installed, DON'T run getOrCloneRepo's
          // auto-clone here — instead instruct Claude to clone it itself into
          // the projects dir (more visible, and it can fix any auth prompts).
          let repoStatus;
          if (notInstalled) {
            repoStatus = {
              path: path.join(config.projectsDir, repoName),
              prepared: false,
              error: 'not-installed',
              needsClone: true,
            };
          } else {
            repoStatus = await getOrCloneRepo(prInfo.fullRepoName, prInfo.headBranch, resolvedPath);
          }

          const prFolder = `PR-${prInfo.prNumber}`;
          const dateStr = new Date().toISOString().split('T')[0];
          const label = kind === 'questions' ? 'Questions' : 'Actions';
          const trackingFile = path.join(config.prReviewsDir, `${repoName}/${prFolder}/${label} ${dateStr}.md`);

          if (!fs.existsSync(trackingFile)) {
            throw new Error(`${label} file not found: ${trackingFile}`);
          }

          const prompt = buildInteractivePrompt({ kind, repoStatus, prInfo, trackingFile, useUltrathink });
          const launchMode = config.runMode === 'print' ? 'print' : 'interactive';
          // If we still need to clone, the repo dir doesn't exist yet, so launch
          // the window from the projects dir (which does) and let Claude clone.
          const launchCwd = repoStatus.needsClone ? config.projectsDir : repoStatus.path;
          // Make sure the launch dir exists either way.
          if (!fs.existsSync(launchCwd)) fs.mkdirSync(launchCwd, { recursive: true });
          const result = launchInteractiveClaude({
            prompt,
            cwd: launchCwd,
            mode: launchMode,
            skipPermissions: useSkip,
            title: `Claude GitHub Buddy - ${label} for PR #${prInfo.prNumber}`,
          });
          return { ...result, trackingFile, repoPath: repoStatus.path };
        })()
          .then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
          })
          .catch((error) => {
            console.error('❌ runInteractive error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
          });
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', directory: config.prReviewsDir }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
    } catch (error) {
      console.error('❌ Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n❌ HTTP port ${PORT} is already in use.`);
    console.error('   The server may already be running. Stop it first, or change HTTP_PORT in .env.\n');
    process.exit(1);
  }
  console.error('[SERVER] HTTP server error:', err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Press Ctrl+C to stop the server\n`);
});

