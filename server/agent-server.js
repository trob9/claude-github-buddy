/**
 * Claude GitHub Buddy - Agent Server
 * WebSocket server + Agent SDK integration for agentic PR reviews
 */

import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from './config.js';
import { getOrCloneRepo } from './git-helper.js';

const WS_PORT = config.wsPort;

/**
 * Build the environment the Agent SDK runs Claude under.
 *
 * Auth model (this is the important bit):
 *   - By DEFAULT we pass the environment through untouched, which means the
 *     Agent SDK authenticates exactly like the local `claude` CLI does — using
 *     whatever you logged in with via `claude login` (i.e. your Claude
 *     subscription / Pro / Max OAuth token in ~/.claude). No API key, no
 *     Vertex, no extra config. This is what makes it "just work" on a machine
 *     where you're already signed into Claude Code.
 *   - Vertex is now OPT-IN: set CLAUDE_CODE_USE_VERTEX=1 in .env (plus the
 *     project/region) to use Google Vertex instead. Previously this was forced
 *     on, which is why the agent failed on machines without Vertex configured.
 */
function buildAgentEnv() {
  const env = { ...process.env };
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') {
    env.CLAUDE_CODE_USE_VERTEX = '1';
    env.ANTHROPIC_VERTEX_PROJECT_ID = process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
    env.CLOUD_ML_REGION = process.env.CLOUD_ML_REGION || '';
  } else {
    // Make sure a stray Vertex flag in the ambient env doesn't force it on.
    delete env.CLAUDE_CODE_USE_VERTEX;
  }
  return env;
}

// Session management
const sessions = new Map(); // sessionId → { socket, settings, workspace, pendingPermissions, abortController }

// WebSocket server. A clean EADDRINUSE message beats an unhandled stack trace
// when the port is taken (usually: the server is already running).
const wss = new WebSocketServer({ port: WS_PORT });
wss.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n❌ WebSocket port ${WS_PORT} is already in use.`);
    console.error('   The server may already be running. Stop it first, or change WS_PORT in .env.\n');
    process.exit(1);
  }
  console.error('[AGENT-WS] WebSocket server error:', err);
});

console.log(`🔌 Agent WebSocket server running on ws://localhost:${WS_PORT}`);

wss.on('connection', (ws, req) => {
  // Extract sessionId from query parameter
  const url = new URL(req.url, `http://localhost:${WS_PORT}`);
  const sessionId = url.searchParams.get('session');

  if (!sessionId) {
    console.error('[AGENT-WS] No session ID provided');
    ws.close(1008, 'No session ID');
    return;
  }

  console.log(`[AGENT-WS] Client connected for session: ${sessionId}`);

  // Get or create session
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      socket: null,
      settings: null,
      workspace: null,
      pendingPermissions: new Map(),
      abortController: new AbortController()
    };
    sessions.set(sessionId, session);
  }

  session.socket = ws;

  // Handle messages from browser
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      handleBrowserMessage(sessionId, data);
    } catch (error) {
      console.error('[AGENT-WS] Error parsing message:', error);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    console.log(`[AGENT-WS] Client disconnected: ${sessionId}`);
    cleanupSession(sessionId);
  });

  // Send connection confirmation
  ws.send(JSON.stringify({ type: 'connected', sessionId }));
});

/**
 * Handle messages from browser
 */
function handleBrowserMessage(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('[AGENT-WS] Session not found:', sessionId);
    return;
  }

  switch (data.type) {
    case 'settings':
      // Browser sends permission settings
      session.settings = data.settings;
      console.log('[AGENT-WS] Settings received:', data.settings);
      break;

    case 'interrupt':
      // User wants to interrupt Claude with a correction
      console.log('[AGENT-WS] Interrupt received:', data.message);
      handleInterrupt(sessionId, data.message);
      break;

    case 'stop':
      // User wants to stop the agent
      console.log('[AGENT-WS] Stop requested');
      handleStop(sessionId);
      break;

    case 'permission_response':
      // Browser responded to permission request
      const pending = session.pendingPermissions.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(data.result);
        session.pendingPermissions.delete(data.requestId);
        console.log(`[AGENT-WS] Permission response: ${data.result.behavior}`);
      }
      break;

    case 'ping':
      // Keep-alive
      session.socket.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      console.warn('[AGENT-WS] Unknown message type:', data.type);
  }
}

/**
 * Start an Agent SDK session for answering questions
 */
export async function answerQuestionsWithAgent(sessionId, prInfo, questionsFilePath, useUltrathink = false) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  if (!session.socket) {
    throw new Error('WebSocket not connected');
  }

  // Wait for settings to arrive (max 5 seconds)
  console.log('[AGENT] Waiting for settings...');
  let waitCount = 0;
  while (!session.settings && waitCount < 50) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waitCount++;
  }

  if (!session.settings) {
    console.warn('[AGENT] ⚠️  Settings not received after 5 seconds, proceeding with defaults');
  } else {
    console.log('[AGENT] ✅ Settings received:', JSON.stringify(session.settings, null, 2));
  }

  // Get or clone the repository to Projects directory
  console.log(`[AGENT] Preparing repository: ${prInfo.fullRepoName}`);
  let repoStatus;
  try {
    repoStatus = await getOrCloneRepo(prInfo.fullRepoName, prInfo.headBranch);
    console.log(`[AGENT] Repository status:`, JSON.stringify(repoStatus, null, 2));
  } catch (error) {
    console.error(`[AGENT] ❌ Failed to prepare repository:`, error.message);
    throw error;
  }

  session.workspace = repoStatus.path;
  session.repoStatus = repoStatus; // Store for prompt generation
  session.interruptQueue = []; // Initialize interrupt queue
  session.questionsFilePath = questionsFilePath; // Store for file watching
  session.questionsCompleted = false; // Track completion

  console.log(`[AGENT] Starting session ${sessionId} in workspace: ${repoStatus.path}`);

  // Read questions file
  let questionsContent = fs.readFileSync(questionsFilePath, 'utf8');

  // Prepend ultrathink instruction if enabled
  if (useUltrathink) {
    questionsContent = `IMPORTANT: Ultrathink for this task. Use <extended_thinking> mode.\n\n${questionsContent}`;
    console.log('[AGENT] ✅ Ultrathink mode enabled');
  }

  console.log(`[AGENT] Questions file location: ${questionsFilePath}`);
  console.log(`[AGENT] Repository location: ${repoStatus.path}`);

  // Send progress update to browser
  sendProgress(sessionId, 'Starting Claude agent...');

  try {
    // Build conditional system prompt based on repository preparation status
    let repoInstructions;
    if (repoStatus.prepared) {
      repoInstructions = `
IMPORTANT: You are already in the repository directory with the correct branch checked out.
DO NOT clone the repository - it's already available in your current directory.
The repository has been prepared and is up-to-date.
- Repository path: ${repoStatus.path}
- Branch '${prInfo.headBranch}' is checked out
- Latest changes have been pulled

CRITICAL - TWO SEPARATE DIRECTORIES:
1. **Code repository**: ${repoStatus.path} (your current working directory)
   - This is where you read code to answer questions
   - DO NOT copy the Questions markdown file into this directory

2. **Questions tracking file**: ${questionsFilePath}
   - This file contains questions and where you write answers
   - Edit this file using its ABSOLUTE PATH: ${questionsFilePath}
   - When adding answers, use: Edit tool with file_path="${questionsFilePath}"
   - This file should NEVER appear in the repository directory

CRITICAL: Ensure you're reviewing the COMMITTED code, not local WIP:
1. Run 'git status' to check for uncommitted local changes
2. IF there are uncommitted changes: Run 'git stash push -m "WIP: Stashing before PR review"'
3. Run 'git reset --hard origin/${prInfo.headBranch}' to ensure you're on the exact remote state
4. Now answer questions based on the committed code in the PR
5. AFTER completing all answers: If you stashed changes in step 2, restore them with 'git stash pop'

This ensures you review only the code that's actually in the PR, not local experiments, and then restore the user's work.
      `.trim();
    } else {
      repoInstructions = `
⚠️  REPOSITORY PREPARATION FAILED: ${repoStatus.error}

The repository exists at: ${repoStatus.path}
However, automatic preparation encountered an issue.

CRITICAL - TWO SEPARATE DIRECTORIES:
1. **Code repository**: ${repoStatus.path} (your current working directory)
   - This is where you read code to answer questions
   - DO NOT copy the Questions markdown file into this directory

2. **Questions tracking file**: ${questionsFilePath}
   - This file contains questions and where you write answers
   - Edit this file using its ABSOLUTE PATH: ${questionsFilePath}
   - When adding answers, use: Edit tool with file_path="${questionsFilePath}"
   - This file should NEVER appear in the repository directory

YOU MUST manually prepare the repository before answering questions:
1. Run 'pwd' to confirm you're in the repository directory
2. Run 'git fetch --all' to fetch latest changes
3. Run 'git checkout ${prInfo.headBranch}' to switch to the PR branch
4. Run 'git pull' to get the latest commits
5. Verify with 'git status' and 'git branch' before proceeding

CRITICAL: Ensure you're reviewing the COMMITTED code, not local WIP:
1. Run 'git status' to check for uncommitted local changes
2. IF there are uncommitted changes: Run 'git stash push -m "WIP: Stashing before PR review"'
3. Run 'git reset --hard origin/${prInfo.headBranch}' to ensure you're on the exact remote state
4. Now answer questions based on the committed code in the PR
5. AFTER completing all answers: If you stashed changes in step 2, restore them with 'git stash pop'

This ensures you review only the code that's actually in the PR, not local experiments, and then restore the user's work.
      `.trim();
    }

    // Start Agent SDK query with message generator for interrupt support
    const result = query({
      prompt: createMessageGenerator(sessionId, questionsContent),
      options: {
        cwd: repoStatus.path,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `
You are answering questions about a GitHub PR review.
The user has selected code snippets and asked questions.
Provide concise, contextual answers based on the full repository context.

${repoInstructions}
          `.trim()
        },
        // Don't load user/project settings - they override our permission system
        // Set all tools to 'ask' mode so canUseTool is always called
        permissionRules: {
          tools: {
            Bash: 'ask',
            Read: 'ask',
            Grep: 'ask',
            Glob: 'ask',
            Write: 'ask',
            Edit: 'ask',
            TodoWrite: 'ask'
          }
        },
        includePartialMessages: true, // Enable streaming updates
        canUseTool: async (toolName, input, options) => {
          console.log('[AGENT] 🔍 canUseTool callback invoked for:', toolName);

          // Only allow specific tools through permission system
          const managedTools = ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'TodoWrite'];
          if (!managedTools.includes(toolName)) {
            console.log(`[AGENT] ❌ Tool ${toolName} not in managed list - denying`);
            return { behavior: 'deny', message: `Tool ${toolName} is not allowed` };
          }

          const result = await canUseTool(sessionId, toolName, input, options);
          console.log('[AGENT] 🔍 canUseTool result:', result);
          return result;
        },
        env: buildAgentEnv(),
        abortController: session.abortController,
        maxTurns: 20
      }
    });

    // Use SDK's built-in event handlers to parse streaming properly
    let currentThinkingText = ''; // Accumulate current text block
    let finalMessage = null;
    let currentToolName = null;
    let currentToolInput = ''; // Accumulate partial JSON

    // The Agent SDK's query() returns an async iterator with proper event parsing
    for await (const message of result) {
      const session = sessions.get(sessionId);

      // Use the SDK's parsed streamEvent objects
      if (message.type === 'stream_event') {
        const event = message.event;

        // CONTENT BLOCK START - Tool use or text begins
        if (event.type === 'content_block_start' && event.content_block) {
          console.log('[AGENT] Content block starting:', event.content_block.type);

          // If starting new block and we have accumulated thinking text, send it now
          if (currentThinkingText.trim()) {
            console.log('[AGENT] 💭 Sending complete thinking block');
            sendProgress(sessionId, currentThinkingText, 'thinking');
            currentThinkingText = '';
          }

          if (event.content_block.type === 'tool_use') {
            currentToolName = event.content_block.name;
            currentToolInput = ''; // Reset for new tool
            console.log('[AGENT] 🔧 Tool starting:', currentToolName);
            // Don't send empty tool label - wait for complete input at content_block_stop
          } else if (event.content_block.type === 'text') {
            console.log('[AGENT] 💭 Text block starting');
            currentThinkingText = ''; // Reset for new text block
          }
        }

        // CONTENT BLOCK DELTA - Streaming text or tool input
        if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta') {
            const text = event.delta.text;
            currentThinkingText += text;
            console.log('[AGENT] 💭 Accumulating text...', currentThinkingText.length, 'chars');
          }

          if (event.delta.type === 'input_json_delta') {
            // Accumulate partial JSON - don't send every fragment
            currentToolInput += event.delta.partial_json;
            console.log('[AGENT] 📝 Accumulating tool input...', currentToolInput.length, 'chars');
          }
        }

        // CONTENT BLOCK STOP - Tool or text complete
        if (event.type === 'content_block_stop') {
          // Send complete thinking text if we have any
          if (currentThinkingText.trim()) {
            console.log('[AGENT] 💭 Text block complete - sending');
            sendProgress(sessionId, currentThinkingText, 'thinking');
            currentThinkingText = '';
          }

          if (currentToolName && currentToolInput) {
            console.log('[AGENT] Tool input complete:', currentToolName);
            // NOW send the complete tool input
            if (session?.socket) {
              try {
                const parsedInput = JSON.parse(currentToolInput);
                const inputPreview = JSON.stringify(parsedInput, null, 2);
                session.socket.send(JSON.stringify({
                  type: 'progress',
                  message: `📝 ${currentToolName}: ${inputPreview.substring(0, 150)}${inputPreview.length > 150 ? '...' : ''}`,
                  status: 'info'
                }));
              } catch (e) {
                // If JSON parsing fails, send raw
                session.socket.send(JSON.stringify({
                  type: 'progress',
                  message: `📝 ${currentToolName}: ${currentToolInput.substring(0, 150)}...`,
                  status: 'info'
                }));
              }
            }
            currentToolName = null;
            currentToolInput = '';
          }
        }

        // MESSAGE STOP - Complete assistant message
        if (event.type === 'message_stop') {
          console.log('[AGENT] Message complete');
        }
      }

      // ASSISTANT MESSAGE (complete) - Has full tool_use blocks with parsed input
      if (message.type === 'assistant' && message.content) {
        finalMessage = message;
        // Streaming events already handled - no need to extract text here
      }

      // USER MESSAGE - Contains tool results
      if (message.type === 'user' && message.content) {
        console.log('[AGENT] Tool results received');
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'tool_result') {
              console.log('[AGENT] Tool result for:', block.tool_use_id);
              if (session?.socket) {
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);

                session.socket.send(JSON.stringify({
                  type: 'tool_result',
                  toolName: block.tool_use_id || 'unknown',
                  result: resultText.substring(0, 200) + (resultText.length > 200 ? '...' : ''),
                  success: !block.is_error
                }));
              }
            }
          }
        }
      }
    }

    const finalText = finalMessage ? extractTextFromContent(finalMessage.content) : '';

    // File was edited in place at ${questionsFilePath} - no copy-back needed
    console.log(`[AGENT] Questions file should be updated at: ${questionsFilePath}`);

    sendProgress(sessionId, 'Processing complete!', 'complete');

    return {
      success: true,
      content: finalText,
      usage: finalMessage?.usage
    };

  } catch (error) {
    console.error('[AGENT] Error:', error);
    sendProgress(sessionId, `Error: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * Check if all questions in the file have been answered
 */
function checkQuestionsAnswered(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;

    const content = fs.readFileSync(filePath, 'utf8');
    const questionBlocks = content.split(/##\s+Question\s+\d+/);

    for (const block of questionBlocks) {
      if (!block.trim()) continue;

      if (block.includes('**QUESTION:**')) {
        const answerMatch = block.match(/\*\*ANSWER:\*\*\s*([^#-]*)/s);
        if (!answerMatch) return false;

        const answer = answerMatch[1].trim();

        // Check if answer is placeholder or too short
        if (answer.length < 10 ||
            answer.includes('[Claude, please fill in') ||
            answer.startsWith('_[')) {
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    console.error('[AGENT] Error checking questions completion:', error);
    return false;
  }
}

/**
 * Check if all actions in the file have completed summaries
 */
function checkActionsCompleted(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;

    const content = fs.readFileSync(filePath, 'utf8');
    const actionBlocks = content.split(/##\s+Action\s+\d+/);

    for (const block of actionBlocks) {
      if (!block.trim()) continue;

      if (block.includes('**ACTION:**')) {
        const summaryMatch = block.match(/\*\*SUMMARY:\*\*\s*([^#-]*)/s);
        if (!summaryMatch) return false;

        const summary = summaryMatch[1].trim();

        // Check if summary is placeholder or too short
        if (summary.length < 10 ||
            summary.includes('[Claude, please fill in') ||
            summary.includes('_[Action summary pending]_') ||
            summary.startsWith('_[')) {
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    console.error('[AGENT] Error checking actions completion:', error);
    return false;
  }
}

/**
 * Create async generator for streaming input mode (supports interrupts)
 */
async function* createMessageGenerator(sessionId, initialPrompt) {
  const session = sessions.get(sessionId);

  // Yield initial prompt
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: initialPrompt
    }
  };

  // Keep checking for queued interrupts and completion status
  while (session && !session.abortController.signal.aborted) {
    // Check if questions are answered (for Questions workflow)
    if (session.questionsFilePath && !session.questionsCompleted) {
      const completed = checkQuestionsAnswered(session.questionsFilePath);
      if (completed) {
        console.log('[AGENT] ✅ All questions answered - ending session');
        session.questionsCompleted = true;
        // Exit the generator loop - this will end the session naturally
        break;
      }
    }

    // Check if actions are completed (for Actions workflow)
    if (session.actionsFilePath && !session.actionsCompleted) {
      const completed = checkActionsCompleted(session.actionsFilePath);
      if (completed) {
        console.log('[AGENT] ✅ All action summaries completed - ending session');
        session.actionsCompleted = true;
        // Exit the generator loop - this will end the session naturally
        break;
      }
    }

    // Check for queued interrupts
    if (session.interruptQueue && session.interruptQueue.length > 0) {
      const interruptMessage = session.interruptQueue.shift();
      console.log('[AGENT] Sending queued interrupt to agent:', interruptMessage);

      yield {
        type: 'user',
        message: {
          role: 'user',
          content: interruptMessage
        }
      };
    }

    // Small delay to avoid busy-waiting (check every 500ms)
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('[AGENT] Message generator exiting');
}

/**
 * Start an Agent SDK session for completing actions
 */
export async function completeActionsWithAgent(sessionId, prInfo, actionsFilePath, useUltrathink = false) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  if (!session.socket) {
    throw new Error('WebSocket not connected');
  }

  // Wait for settings to arrive (max 5 seconds)
  console.log('[AGENT] Waiting for settings...');
  let waitCount = 0;
  while (!session.settings && waitCount < 50) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waitCount++;
  }

  if (!session.settings) {
    console.warn('[AGENT] ⚠️  Settings not received after 5 seconds, proceeding with defaults');
  } else {
    console.log('[AGENT] ✅ Settings received:', JSON.stringify(session.settings, null, 2));
  }

  // Get or clone the repository to Projects directory
  console.log(`[AGENT] Preparing repository for actions: ${prInfo.fullRepoName}`);
  let repoStatus;
  try {
    repoStatus = await getOrCloneRepo(prInfo.fullRepoName, prInfo.headBranch);
    console.log(`[AGENT] Repository status:`, JSON.stringify(repoStatus, null, 2));
  } catch (error) {
    console.error(`[AGENT] ❌ Failed to prepare repository:`, error.message);
    throw error;
  }

  session.workspace = repoStatus.path;
  session.repoStatus = repoStatus; // Store for prompt generation
  session.interruptQueue = []; // Initialize interrupt queue
  session.actionsFilePath = actionsFilePath; // Store for file watching
  session.actionsCompleted = false; // Track completion

  console.log(`[AGENT] Starting action session ${sessionId} in workspace: ${repoStatus.path}`);

  // Read actions file
  let actionsContent = fs.readFileSync(actionsFilePath, 'utf8');

  // Prepend ultrathink instruction if enabled
  if (useUltrathink) {
    actionsContent = `IMPORTANT: Ultrathink for this task. Use <extended_thinking> mode.\n\n${actionsContent}`;
    console.log('[AGENT] ✅ Ultrathink mode enabled');
  }

  console.log(`[AGENT] Actions file location: ${actionsFilePath}`);
  console.log(`[AGENT] Repository location: ${repoStatus.path}`);

  sendProgress(sessionId, 'Starting Claude agent for actions...');

  try {
    // Build conditional system prompt based on repository preparation status
    let repoInstructions;
    if (repoStatus.prepared) {
      repoInstructions = `
IMPORTANT: You are already in the repository directory with the correct branch checked out.
DO NOT clone the repository - it's already available in your current directory.
The repository has been prepared and is up-to-date.
- Repository path: ${repoStatus.path}
- Branch '${prInfo.headBranch}' is checked out
- Latest changes have been pulled

CRITICAL - TWO SEPARATE DIRECTORIES:
1. **Code repository**: ${repoStatus.path} (your current working directory)
   - This is where you make code changes, run tests, commit, and push
   - DO NOT copy the Actions markdown file into this directory
   - DO NOT commit the Actions markdown file to git

2. **Actions tracking file**: ${actionsFilePath}
   - This file tracks what you need to do and what you've done
   - Edit this file using its ABSOLUTE PATH: ${actionsFilePath}
   - When updating summaries, use: Edit tool with file_path="${actionsFilePath}"
   - This file should NEVER appear in git status or be committed to the repo

CRITICAL GIT WORKFLOW - Follow this sequence exactly:
1. BEFORE making any changes: Run 'git status' to check for uncommitted local changes
2. IF there are uncommitted changes: Run 'git stash push -m "WIP: Saving local changes before PR review actions"'
3. Make your requested changes, run tests (if needed), and commit with a clear message
4. Push your commit: 'git push'
5. ONLY AFTER pushing successfully: If you stashed changes in step 2, restore them with 'git stash pop'

This ensures local work-in-progress is never accidentally pushed to the remote branch.

CRITICAL: Before finishing this session, you MUST:
- Use the Read tool to read the Actions file: ${actionsFilePath}
- Verify EVERY action has a filled-in SUMMARY section (not placeholder text)
- If any summaries are missing, use Edit tool with file_path="${actionsFilePath}" to fill them NOW
- DO NOT say "ready to wrap up" or "all done" until you have verified ALL summaries are complete
- Remember: The Actions file is NOT in the repository directory - use the absolute path above
      `.trim();
    } else {
      repoInstructions = `
⚠️  REPOSITORY PREPARATION FAILED: ${repoStatus.error}

The repository exists at: ${repoStatus.path}
However, automatic preparation encountered an issue.

CRITICAL - TWO SEPARATE DIRECTORIES:
1. **Code repository**: ${repoStatus.path} (your current working directory)
   - This is where you make code changes, run tests, commit, and push
   - DO NOT copy the Actions markdown file into this directory
   - DO NOT commit the Actions markdown file to git

2. **Actions tracking file**: ${actionsFilePath}
   - This file tracks what you need to do and what you've done
   - Edit this file using its ABSOLUTE PATH: ${actionsFilePath}
   - When updating summaries, use: Edit tool with file_path="${actionsFilePath}"
   - This file should NEVER appear in git status or be committed to the repo

YOU MUST manually prepare the repository before completing actions:
1. Run 'pwd' to confirm you're in the repository directory
2. Run 'git fetch --all' to fetch latest changes
3. Run 'git checkout ${prInfo.headBranch}' to switch to the PR branch
4. Run 'git pull' to get the latest commits
5. Verify with 'git status' and 'git branch' before proceeding

CRITICAL GIT WORKFLOW - After preparation, follow this sequence:
1. Run 'git status' to check for uncommitted local changes
2. IF there are uncommitted changes: Run 'git stash push -m "WIP: Saving local changes before PR review actions"'
3. Make your requested changes, run tests (if needed), and commit with a clear message
4. Push your commit: 'git push'
5. ONLY AFTER pushing successfully: If you stashed changes in step 2, restore them with 'git stash pop'

This ensures local work-in-progress is never accidentally pushed to the remote branch.

CRITICAL: Before finishing this session, you MUST:
- Use the Read tool to read the Actions file: ${actionsFilePath}
- Verify EVERY action has a filled-in SUMMARY section (not placeholder text)
- If any summaries are missing, use Edit tool with file_path="${actionsFilePath}" to fill them NOW
- DO NOT say "ready to wrap up" or "all done" until you have verified ALL summaries are complete
- Remember: The Actions file is NOT in the repository directory - use the absolute path above
      `.trim();
    }

    const result = query({
      prompt: createMessageGenerator(sessionId, actionsContent),
      options: {
        cwd: repoStatus.path,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `
You are completing actions for a GitHub PR review.
The user has marked code sections for action.
Complete the requested actions, run tests, and ensure quality.

${repoInstructions}
          `.trim()
        },
        // Don't load user/project settings - they override our permission system
        // Set all tools to 'ask' mode so canUseTool is always called
        permissionRules: {
          tools: {
            Bash: 'ask',
            Read: 'ask',
            Grep: 'ask',
            Glob: 'ask',
            Write: 'ask',
            Edit: 'ask',
            TodoWrite: 'ask'
          }
        },
        includePartialMessages: true, // Enable streaming updates
        canUseTool: async (toolName, input, options) => {
          console.log('[AGENT] 🔍 canUseTool callback invoked for:', toolName);
          const result = await canUseTool(sessionId, toolName, input, options);
          console.log('[AGENT] 🔍 canUseTool result:', result);
          return result;
        },
        env: buildAgentEnv(),
        abortController: session.abortController,
        maxTurns: 30
      }
    });

    // Use SDK's built-in event handlers to parse streaming properly
    let currentThinkingText = ''; // Accumulate current text block
    let finalMessage = null;
    let currentToolName = null;
    let currentToolInput = ''; // Accumulate partial JSON

    // The Agent SDK's query() returns an async iterator with proper event parsing
    for await (const message of result) {
      const session = sessions.get(sessionId);

      // Use the SDK's parsed streamEvent objects
      if (message.type === 'stream_event') {
        const event = message.event;

        // CONTENT BLOCK START - Tool use or text begins
        if (event.type === 'content_block_start' && event.content_block) {
          console.log('[AGENT] Content block starting:', event.content_block.type);

          // If starting new block and we have accumulated thinking text, send it now
          if (currentThinkingText.trim()) {
            console.log('[AGENT] 💭 Sending complete thinking block');
            sendProgress(sessionId, currentThinkingText, 'thinking');
            currentThinkingText = '';
          }

          if (event.content_block.type === 'tool_use') {
            currentToolName = event.content_block.name;
            currentToolInput = ''; // Reset for new tool
            console.log('[AGENT] 🔧 Tool starting:', currentToolName);
            // Don't send empty tool label - wait for complete input at content_block_stop
          } else if (event.content_block.type === 'text') {
            console.log('[AGENT] 💭 Text block starting');
            currentThinkingText = ''; // Reset for new text block
          }
        }

        // CONTENT BLOCK DELTA - Streaming text or tool input
        if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta') {
            const text = event.delta.text;
            currentThinkingText += text;
            console.log('[AGENT] 💭 Accumulating text...', currentThinkingText.length, 'chars');
          }

          if (event.delta.type === 'input_json_delta') {
            // Accumulate partial JSON - don't send every fragment
            currentToolInput += event.delta.partial_json;
            console.log('[AGENT] 📝 Accumulating tool input...', currentToolInput.length, 'chars');
          }
        }

        // CONTENT BLOCK STOP - Tool or text complete
        if (event.type === 'content_block_stop') {
          // Send complete thinking text if we have any
          if (currentThinkingText.trim()) {
            console.log('[AGENT] 💭 Text block complete - sending');
            sendProgress(sessionId, currentThinkingText, 'thinking');
            currentThinkingText = '';
          }

          if (currentToolName && currentToolInput) {
            console.log('[AGENT] Tool input complete:', currentToolName);
            // NOW send the complete tool input
            if (session?.socket) {
              try {
                const parsedInput = JSON.parse(currentToolInput);
                const inputPreview = JSON.stringify(parsedInput, null, 2);
                session.socket.send(JSON.stringify({
                  type: 'progress',
                  message: `📝 ${currentToolName}: ${inputPreview.substring(0, 150)}${inputPreview.length > 150 ? '...' : ''}`,
                  status: 'info'
                }));
              } catch (e) {
                // If JSON parsing fails, send raw
                session.socket.send(JSON.stringify({
                  type: 'progress',
                  message: `📝 ${currentToolName}: ${currentToolInput.substring(0, 150)}...`,
                  status: 'info'
                }));
              }
            }
            currentToolName = null;
            currentToolInput = '';
          }
        }

        // MESSAGE STOP - Complete assistant message
        if (event.type === 'message_stop') {
          console.log('[AGENT] Message complete');
        }
      }

      // ASSISTANT MESSAGE (complete) - Has full tool_use blocks with parsed input
      if (message.type === 'assistant' && message.content) {
        finalMessage = message;
        // Streaming events already handled - no need to extract text here
      }

      // USER MESSAGE - Contains tool results
      if (message.type === 'user' && message.content) {
        console.log('[AGENT] Tool results received');
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'tool_result') {
              console.log('[AGENT] Tool result for:', block.tool_use_id);
              if (session?.socket) {
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);

                session.socket.send(JSON.stringify({
                  type: 'tool_result',
                  toolName: block.tool_use_id || 'unknown',
                  result: resultText.substring(0, 200) + (resultText.length > 200 ? '...' : ''),
                  success: !block.is_error
                }));
              }
            }
          }
        }
      }
    }

    const finalText = finalMessage ? extractTextFromContent(finalMessage.content) : '';

    // File was edited in place at ${actionsFilePath} - no copy-back needed
    console.log(`[AGENT] Actions file should be updated at: ${actionsFilePath}`);

    sendProgress(sessionId, 'Actions complete!', 'complete');

    return {
      success: true,
      content: finalText,
      usage: finalMessage?.usage
    };

  } catch (error) {
    console.error('[AGENT] Error:', error);
    sendProgress(sessionId, `Error: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * Permission callback for Agent SDK
 */
async function canUseTool(sessionId, toolName, input, options) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('[AGENT] Session not found for permission check:', sessionId);
    return { behavior: 'deny', message: 'Session not found' };
  }

  if (!session.socket) {
    console.error('[AGENT] No WebSocket connection for session:', sessionId);
    return { behavior: 'deny', message: 'No browser connection' };
  }

  // Check if auto-approved in user settings
  const isAutoApproved = session.settings?.permissions?.[toolName] === true;

  console.log(`[AGENT] Permission check for ${toolName}:`);
  console.log(`  - session.settings:`, JSON.stringify(session.settings, null, 2));
  console.log(`  - session.settings?.permissions?.[${toolName}]:`, session.settings?.permissions?.[toolName]);
  console.log(`  - isAutoApproved:`, isAutoApproved);

  if (isAutoApproved) {
    console.log(`[AGENT] ✅ Auto-approved: ${toolName}`);
    return { behavior: 'allow', updatedInput: input };
  }

  // Need user approval - send request to browser
  console.log(`[AGENT] ❓ Requesting permission: ${toolName}`, input);

  const requestId = randomUUID();

  return new Promise((resolve) => {
    // Set timeout (30 seconds)
    const timeout = setTimeout(() => {
      console.error('[AGENT] ⏱️  Permission request timeout');
      session.pendingPermissions.delete(requestId);
      resolve({
        behavior: 'deny',
        message: 'Permission request timed out after 30 seconds'
      });
    }, 30000);

    // Store pending request
    session.pendingPermissions.set(requestId, { resolve, timeout });

    // Send request to browser
    session.socket.send(JSON.stringify({
      type: 'permission_request',
      requestId,
      toolName,
      input,
      decisionReason: options.decisionReason,
      suggestions: options.suggestions
    }));
  });
}

/**
 * Send progress update to browser
 */
function sendProgress(sessionId, message, type = 'progress') {
  const session = sessions.get(sessionId);
  if (session?.socket) {
    session.socket.send(JSON.stringify({
      type,
      message
    }));
  }
}

/**
 * Handle interrupt from user
 * Queues the interrupt message to be sent to the agent
 */
function handleInterrupt(sessionId, message) {
  const session = sessions.get(sessionId);
  if (!session) return;

  console.log(`[AGENT] User interrupt for session ${sessionId}:`, message);

  // Queue the interrupt message
  if (!session.interruptQueue) {
    session.interruptQueue = [];
  }
  session.interruptQueue.push(message);

  // Send acknowledgment back to browser
  sendProgress(sessionId, `Interrupt queued: ${message}`, 'interrupt');

  console.log('[AGENT] Interrupt queued successfully');
}

/**
 * Handle stop request from user
 */
function handleStop(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  console.log(`[AGENT] Stopping session ${sessionId}`);

  // Abort the current Agent SDK operation
  if (session.abortController) {
    session.abortController.abort();
    sendProgress(sessionId, 'Agent stopped by user', 'error');
  }

  // Clean up session
  cleanupSession(sessionId);
}

/**
 * Extract text from Agent SDK content array
 */
function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n');
  }
  return '';
}

/**
 * Cleanup session
 */
function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    // Abort any ongoing Agent SDK query
    session.abortController.abort();

    // Clear pending permissions
    session.pendingPermissions.forEach(pending => {
      clearTimeout(pending.timeout);
      pending.resolve({ behavior: 'deny', message: 'Session closed' });
    });

    sessions.delete(sessionId);
    console.log(`[AGENT] Session cleaned up: ${sessionId}`);
  }
}

/**
 * Create a new session and return sessionId
 */
export function createSession() {
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    socket: null,
    settings: null,
    workspace: null,
    pendingPermissions: new Map(),
    abortController: new AbortController()
  });
  console.log(`[AGENT] Created session: ${sessionId}`);
  return sessionId;
}

/**
 * Get session status
 */
export function getSessionStatus(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { exists: false };
  }
  return {
    exists: true,
    connected: !!session.socket,
    hasSettings: !!session.settings
  };
}
