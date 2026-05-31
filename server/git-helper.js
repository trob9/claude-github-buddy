#!/usr/bin/env node

/**
 * Git Repository Helper
 * Manages repository cloning and updates efficiently
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { config } from './config.js';

/**
 * Get or clone a repository, returning the path and preparation status
 * @param {string} fullRepoName - e.g., "myorg/myrepo" or "github.example.com/myorg/myrepo"
 * @param {string} branch - Branch to checkout
 * @returns {Promise<{path: string, prepared: boolean, cloned: boolean, checkedOut: boolean, pulled: boolean, error: string|null}>}
 */
export async function getOrCloneRepo(fullRepoName, branch, repoPathOverride) {
  // Extract repo name (last part of path)
  const repoName = fullRepoName.split('/').pop();
  // If the caller knows where this repo already lives (a remembered custom
  // path, or one the user just provided), use it; else default to
  // <projectsDir>/<repoName>.
  const repoPath = repoPathOverride || path.join(config.projectsDir, repoName);

  console.log(`[GIT] Checking for repo: ${repoName}`);
  console.log(`[GIT] Expected path: ${repoPath}`);

  const status = {
    path: repoPath,
    prepared: false,
    cloned: false,
    checkedOut: false,
    pulled: false,
    error: null
  };

  // Check if repo already exists
  if (fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'))) {
    console.log(`[GIT] ✅ Found existing repo at ${repoPath}`);

    // Try to fetch latest changes
    try {
      console.log(`[GIT] Fetching latest changes...`);
      execSync('git fetch --all', { cwd: repoPath, stdio: 'inherit' });
    } catch (error) {
      console.error(`[GIT] ❌ Fetch failed:`, error.message);
      status.error = `Failed to fetch latest changes: ${error.message}`;
      return status;
    }

    // Check if branch exists locally or remotely
    let branchExists = false;
    try {
      execSync(`git rev-parse --verify ${branch}`, { cwd: repoPath, stdio: 'pipe' });
      branchExists = true;
    } catch (e) {
      // Try remote branch
      try {
        execSync(`git rev-parse --verify origin/${branch}`, { cwd: repoPath, stdio: 'pipe' });
        branchExists = true;
      } catch (e2) {
        console.log(`[GIT] ⚠️  Branch ${branch} not found locally or remotely`);
        status.error = `Branch '${branch}' not found locally or remotely`;
        return status;
      }
    }

    if (!branchExists) {
      status.error = `Branch '${branch}' does not exist`;
      return status;
    }

    // Checkout the branch
    console.log(`[GIT] Checking out branch: ${branch}`);
    try {
      execSync(`git checkout ${branch}`, { cwd: repoPath, stdio: 'inherit' });
      status.checkedOut = true;
    } catch (e) {
      try {
        console.log(`[GIT] Branch doesn't exist locally, creating from remote...`);
        execSync(`git checkout -b ${branch} origin/${branch}`, { cwd: repoPath, stdio: 'inherit' });
        status.checkedOut = true;
      } catch (e2) {
        console.error(`[GIT] ❌ Checkout failed:`, e2.message);
        status.error = `Failed to checkout branch '${branch}': ${e2.message}`;
        return status;
      }
    }

    // Pull latest changes
    console.log(`[GIT] Pulling latest changes...`);
    try {
      execSync('git pull', { cwd: repoPath, stdio: 'inherit' });
      status.pulled = true;
    } catch (e) {
      console.error(`[GIT] ❌ Pull failed:`, e.message);
      status.error = `Failed to pull latest changes: ${e.message}`;
      return status;
    }

    console.log(`[GIT] ✅ Repository ready at ${repoPath}`);
    status.prepared = true;
    return status;
  }

  // Repo doesn't exist, need to clone
  console.log(`[GIT] Repository not found, cloning to ${repoPath}...`);

  // Determine clone URL based on configuration
  let cloneUrl = getCloneUrl(fullRepoName);

  try {
    // Ensure Projects directory exists
    if (!fs.existsSync(config.projectsDir)) {
      fs.mkdirSync(config.projectsDir, { recursive: true });
    }

    // Clone the repository. Quote repoPath so Windows paths containing
    // spaces (e.g. C:\Users\Some User\Projects) don't break the command.
    console.log(`[GIT] Cloning from ${cloneUrl}...`);
    execSync(`git clone ${cloneUrl} "${repoPath}"`, { stdio: 'inherit' });
    status.cloned = true;

    // Checkout the branch if it's not the default
    if (branch && branch !== 'main' && branch !== 'master') {
      console.log(`[GIT] Checking out branch: ${branch}`);
      try {
        execSync(`git checkout ${branch}`, { cwd: repoPath, stdio: 'inherit' });
        status.checkedOut = true;
      } catch (e) {
        try {
          console.log(`[GIT] Branch doesn't exist locally, creating from remote...`);
          execSync(`git checkout -b ${branch} origin/${branch}`, { cwd: repoPath, stdio: 'inherit' });
          status.checkedOut = true;
        } catch (e2) {
          console.error(`[GIT] ❌ Checkout failed after clone:`, e2.message);
          status.error = `Repository cloned but failed to checkout branch '${branch}': ${e2.message}`;
          return status;
        }
      }
    } else {
      status.checkedOut = true; // Already on default branch
    }

    console.log(`[GIT] ✅ Repository cloned successfully to ${repoPath}`);
    status.prepared = true;
    status.pulled = true; // Fresh clone is already up-to-date
    return status;
  } catch (error) {
    console.error(`[GIT] ❌ Error cloning repo:`, error.message);
    status.error = `Failed to clone repository: ${error.message}`;
    return status;
  }
}

/**
 * Determine the correct clone URL for the repository.
 * Honors the configured protocol (config.js → git['github.com'].protocol).
 * Defaults to HTTPS, which works on Windows via Git Credential Manager and
 * anywhere `gh auth login` has run — no SSH key required.
 */
function getCloneUrl(fullRepoName) {
  const host = 'github.com';
  const protocol = config.git?.[host]?.protocol || 'https';

  if (protocol === 'ssh') {
    return `git@${host}:${fullRepoName}.git`;
  }
  return `https://${host}/${fullRepoName}.git`;
}

/**
 * Get the diff between two branches
 */
export function getDiff(repoPath, baseBranch, headBranch) {
  try {
    console.log(`[GIT] Getting diff between ${baseBranch} and ${headBranch}...`);
    const diff = execSync(`git diff origin/${baseBranch}...${headBranch}`, {
      cwd: repoPath,
      encoding: 'utf8'
    });
    return diff;
  } catch (error) {
    console.error(`[GIT] ❌ Error getting diff:`, error.message);
    return '';
  }
}
