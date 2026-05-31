#!/usr/bin/env node

/**
 * Configuration for Claude GitHub Buddy Server
 *
 * Configuration priority (highest to lowest):
 * 1. Environment variables (from .env file or system)
 * 2. config.json (UI settings)
 * 3. Defaults
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = path.join(__dirname, 'config.json');
const envPath = path.join(dirname(__dirname), '.env');

// Load .env file if it exists
function loadEnv() {
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        if (key && value && !process.env[key]) {
          process.env[key] = value;
        }
      }
    });
  }
}

loadEnv();

// Load user configuration from JSON file
let userConfig = {};
try {
  if (fs.existsSync(configPath)) {
    const configData = fs.readFileSync(configPath, 'utf8');
    userConfig = JSON.parse(configData);
  }
} catch (error) {
  console.error('[CONFIG] Error loading config.json:', error);
}

// The four "native Claude setup" run modes.
const RUN_MODES = ['interactive', 'print', 'sdk', 'vertex'];

/**
 * Resolve how the server should run Claude ("native Claude setup"):
 *   - 'interactive' → opens a REAL interactive `claude` window (no -p). Anthropic
 *                     counts this as NORMAL Claude subscription usage. The window
 *                     stays open so you can watch/steer it.
 *   - 'print'       → runs `claude -p` in a window that closes when done. Per
 *                     Anthropic billing, -p draws from the separate Agent-SDK
 *                     credit (API rates), NOT your interactive subscription.
 *   - 'sdk'         → Agent SDK headless, billed to an ANTHROPIC_API_KEY.
 *                     Streams to the in-browser monitor panel.
 *   - 'vertex'      → Agent SDK headless, billed via Google Vertex.
 *                     Streams to the in-browser monitor panel.
 *
 * Priority: explicit CLAUDE_RUN_MODE env > config.json runMode > inference.
 * Inference: Vertex flag → vertex; API key present → sdk; otherwise default to
 * 'interactive' (the "I'm signed into Claude, use my subscription" case).
 */
function resolveRunMode() {
  const explicit = (process.env.CLAUDE_RUN_MODE || userConfig.runMode || '').toLowerCase();
  if (RUN_MODES.includes(explicit)) return explicit;
  // Back-compat: an older 'subscription' value now means interactive.
  if (explicit === 'subscription') return 'interactive';
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') return 'vertex';
  if (process.env.ANTHROPIC_API_KEY) return 'sdk';
  return 'interactive';
}

export const config = {
  // How Claude is invoked. See resolveRunMode() above.
  runMode: resolveRunMode(),

  // Whether the interactive/print Claude window starts with
  // --dangerously-skip-permissions, so it can answer questions / perform
  // actions autonomously without stopping to ask for tool approval. Default
  // off; can be enabled persistently in settings, or as a one-off per run.
  skipPermissions: process.env.CLAUDE_SKIP_PERMISSIONS === '1' || userConfig.skipPermissions === true,

  // Remembered per-repo locations: { "owner/repo": "C:\\path\\to\\repo" }.
  // When the user points us at an existing clone outside projectsDir, we save
  // it here so we auto-detect it next time instead of asking again.
  repoPaths: (userConfig.repoPaths && typeof userConfig.repoPaths === 'object') ? { ...userConfig.repoPaths } : {},

  // User-configurable directories (priority: env > config.json > defaults)
  prReviewsDir: process.env.PR_REVIEWS_DIR || userConfig.prReviewsDir || path.join(dirname(__dirname), 'questions and actions'),
  // os.homedir() is cross-platform: $HOME on macOS/Linux, %USERPROFILE% on Windows
  projectsDir: process.env.PROJECTS_DIR || userConfig.projectsDir || path.join(os.homedir(), 'Projects'),

  // Server ports (priority: env > hardcoded)
  httpPort: parseInt(process.env.HTTP_PORT) || 13030,
  wsPort: parseInt(process.env.WS_PORT) || 13031,

  // Git configuration - customize based on your git setup.
  // Default to HTTPS: it works out-of-the-box on Windows (Git Credential
  // Manager) and anywhere `gh auth login` has run, without needing SSH keys.
  // Set GIT_GITHUB_PROTOCOL=ssh in .env to use SSH instead.
  git: {
    'github.com': {
      protocol: process.env.GIT_GITHUB_PROTOCOL || 'https',
      sshKey: process.env.GIT_GITHUB_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519')
    }
  }
};

/**
 * Reload configuration from config.json
 * Called when user updates settings via UI
 */
export function reloadConfig() {
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const newConfig = JSON.parse(configData);

    // Update the exported config object
    config.prReviewsDir = newConfig.prReviewsDir || config.prReviewsDir;
    config.projectsDir = newConfig.projectsDir || config.projectsDir;
    // runMode is only overridden by config.json when env didn't force it.
    if (!process.env.CLAUDE_RUN_MODE && newConfig.runMode) {
      let m = String(newConfig.runMode).toLowerCase();
      if (m === 'subscription') m = 'interactive'; // back-compat
      if (RUN_MODES.includes(m)) config.runMode = m;
    }
    // skipPermissions is overridden by config.json unless the env forces it on.
    if (process.env.CLAUDE_SKIP_PERMISSIONS !== '1' && typeof newConfig.skipPermissions === 'boolean') {
      config.skipPermissions = newConfig.skipPermissions;
    }
    if (newConfig.repoPaths && typeof newConfig.repoPaths === 'object') {
      config.repoPaths = { ...newConfig.repoPaths };
    }

    console.log('[CONFIG] Configuration reloaded:', {
      prReviewsDir: config.prReviewsDir,
      projectsDir: config.projectsDir,
      runMode: config.runMode,
      skipPermissions: config.skipPermissions
    });
    return true;
  } catch (error) {
    console.error('[CONFIG] Error reloading config:', error);
    return false;
  }
}
