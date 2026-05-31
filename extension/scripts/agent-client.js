/**
 * Claude GitHub Buddy - Agent WebSocket Client
 * Manages WebSocket connection to server for agentic PR reviews
 */

class AgentClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.messageHandlers = new Map();
    this.lastMessageTime = null;
    this.heartbeatInterval = null;
    this.heartbeatWarningThreshold = 60000; // 60 seconds
    this.isAgentActive = false;
  }

  /**
   * Start a new agent session
   */
  async startSession() {
    // Create session on server
    const response = await fetch('http://localhost:47382/startSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'Failed to start session');
    }

    this.sessionId = result.sessionId;
    console.log('[AGENT-CLIENT] Session created:', this.sessionId);

    // Establish WebSocket connection
    return this.connect();
  }

  /**
   * Connect to WebSocket server
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (!this.sessionId) {
        reject(new Error('No session ID'));
        return;
      }

      const wsUrl = `ws://localhost:47383?session=${this.sessionId}`;
      console.log('[AGENT-CLIENT] Connecting to:', wsUrl);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[AGENT-CLIENT] WebSocket connected');
        this.connected = true;

        // Send permission settings
        this.sendSettings();

        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('[AGENT-CLIENT] WebSocket error:', error);
        this.connected = false;
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('[AGENT-CLIENT] WebSocket closed');
        this.connected = false;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (error) {
          console.error('[AGENT-CLIENT] Error parsing message:', error);
        }
      };
    });
  }

  /**
   * Send permission settings to server
   */
  async sendSettings() {
    const settings = await this.loadSettings();
    console.log('[AGENT-CLIENT] Sending settings:', settings);

    this.send({
      type: 'settings',
      settings
    });
  }

  /**
   * Load permission settings from Chrome storage
   */
  async loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get('agent_permissions', (result) => {
        const defaultPermissions = {
          Read: true,      // Safe: read-only
          Grep: true,      // Safe: read-only
          Glob: true,      // Safe: read-only
          Bash: false,     // Dangerous: can execute anything
          Write: false,    // Dangerous: can overwrite files
          Edit: false,     // Dangerous: can modify files
          TodoWrite: true, // Safe: just task tracking
          WebSearch: false,
          WebFetch: false
        };

        const permissions = result.agent_permissions || defaultPermissions;

        // Save defaults if not exist
        if (!result.agent_permissions) {
          chrome.storage.local.set({ agent_permissions: defaultPermissions });
        }

        resolve({ permissions });
      });
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(data) {
    console.log('[AGENT-CLIENT] Received:', data.type);

    // Update last message time for heartbeat monitoring
    this.lastMessageTime = Date.now();

    switch (data.type) {
      case 'connected':
        console.log('[AGENT-CLIENT] Server confirmed connection');
        break;

      case 'permission_request':
        this.handlePermissionRequest(data);
        break;

      case 'progress':
        this.handleProgress(data);
        break;

      case 'thinking':
        this.handleThinking(data);
        break;

      case 'tool_use':
        this.handleToolUse(data);
        break;

      case 'complete':
        this.handleComplete(data);
        break;

      case 'error':
        this.handleError(data);
        break;

      case 'tool_result':
        this.handleToolResult(data);
        break;

      case 'interrupt':
        this.handleInterruptAck(data);
        break;

      case 'stop':
        // Stop acknowledgment - agent is stopping
        console.log('[AGENT-CLIENT] Stop acknowledged');
        break;

      case 'pong':
        // Keep-alive response
        break;

      default:
        console.warn('[AGENT-CLIENT] Unknown message type:', data.type);
    }

    // Call registered handlers
    const handlers = this.messageHandlers.get(data.type);
    if (handlers) {
      handlers.forEach(handler => handler(data));
    }
  }

  /**
   * Handle permission request from server
   */
  async handlePermissionRequest(data) {
    console.log('[AGENT-CLIENT] Permission request:', data.toolName, data.input);

    // Show permission dialog to user
    const result = await showPermissionDialog({
      requestId: data.requestId,
      toolName: data.toolName,
      input: data.input,
      decisionReason: data.decisionReason,
      suggestions: data.suggestions
    });

    // Send response back to server
    this.send({
      type: 'permission_response',
      requestId: data.requestId,
      result
    });
  }

  /**
   * Handle progress update
   */
  handleProgress(data) {
    console.log('[AGENT-CLIENT] Progress:', data.message);

    // Update monitor panel
    if (window.agentMonitorPanel && window.agentMonitorPanel.isOpen) {
      window.agentMonitorPanel.addLog(data.message, 'info');
    }
  }

  /**
   * Handle thinking/reasoning text
   */
  handleThinking(data) {
    console.log('[AGENT-CLIENT] Thinking:', data.message);

    // Update monitor panel with thinking text
    if (window.agentMonitorPanel && window.agentMonitorPanel.isOpen) {
      window.agentMonitorPanel.onThinking(data.message);
    }
  }

  /**
   * Handle tool use notification
   */
  handleToolUse(data) {
    console.log('[AGENT-CLIENT] Tool used:', data.message);

    // Update monitor panel with detailed tool info
    if (window.agentMonitorPanel && window.agentMonitorPanel.isOpen) {
      window.agentMonitorPanel.onToolUse(data.toolName, data.input || data.message);
    }
  }

  /**
   * Handle completion
   */
  handleComplete(data) {
    console.log('[AGENT-CLIENT] Complete:', data.message);

    // Update monitor panel
    if (window.agentMonitorPanel) {
      window.agentMonitorPanel.onComplete();
    }
  }

  /**
   * Handle error
   */
  handleError(data) {
    console.error('[AGENT-CLIENT] Error:', data.message);

    // Update monitor panel
    if (window.agentMonitorPanel) {
      window.agentMonitorPanel.onError(data.message);
    }
  }

  /**
   * Handle tool result
   */
  handleToolResult(data) {
    console.log('[AGENT-CLIENT] Tool result:', data.toolName, data.success);

    // Update monitor panel
    if (window.agentMonitorPanel && window.agentMonitorPanel.isOpen) {
      window.agentMonitorPanel.onToolResult(data.toolName, data.result, data.success);
    }
  }

  /**
   * Handle interrupt acknowledgment
   */
  handleInterruptAck(data) {
    console.log('[AGENT-CLIENT] Interrupt acknowledged:', data.message);

    // Update monitor panel
    if (window.agentMonitorPanel && window.agentMonitorPanel.isOpen) {
      window.agentMonitorPanel.addLog(data.message, 'info');
    }
  }

  /**
   * Show notification to user
   */
  showNotification(message, type = 'info') {
    // Reuse existing showNotification function from content.js
    if (typeof window.showNotification === 'function') {
      window.showNotification(message);
    } else {
      console.log(`[${type.toUpperCase()}]`, message);
    }
  }

  /**
   * Send message to server
   */
  send(data) {
    if (!this.connected || !this.ws) {
      console.error('[AGENT-CLIENT] Not connected');
      return;
    }

    this.ws.send(JSON.stringify(data));
  }

  /**
   * Register message handler
   */
  on(messageType, handler) {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, []);
    }
    this.messageHandlers.get(messageType).push(handler);
  }

  /**
   * Close connection
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.sessionId = null;
  }

  /**
   * Start heartbeat monitoring
   */
  startHeartbeatMonitoring() {
    this.lastMessageTime = Date.now();
    this.isAgentActive = true;

    // Start pulse indicator in monitor panel
    if (window.agentMonitorPanel) {
      window.agentMonitorPanel.startPulse();
    }

    // Clear any existing interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Check every 10 seconds
    this.heartbeatInterval = setInterval(() => {
      if (!this.isAgentActive) return;

      const timeSinceLastMessage = Date.now() - this.lastMessageTime;

      if (timeSinceLastMessage > this.heartbeatWarningThreshold) {
        console.warn('[AGENT-CLIENT] ⚠️  No message from Claude for', Math.floor(timeSinceLastMessage / 1000), 'seconds');

        // Notify monitor panel
        if (window.agentMonitorPanel && window.agentMonitorPanel.isOpen) {
          window.agentMonitorPanel.addLog(
            `⚠️ Warning: No activity from Claude for ${Math.floor(timeSinceLastMessage / 1000)} seconds. Agent may be stuck.`,
            'warning'
          );
        }
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Stop heartbeat monitoring
   */
  stopHeartbeatMonitoring() {
    this.isAgentActive = false;

    // Stop pulse indicator in monitor panel
    if (window.agentMonitorPanel) {
      window.agentMonitorPanel.stopPulse();
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Answer questions using Agent SDK
   */
  async answerQuestions(prInfo, useUltrathink = false) {
    if (!this.sessionId) {
      throw new Error('No session - call startSession() first');
    }

    console.log('[AGENT-CLIENT] Calling /answerQuestions with:', { sessionId: this.sessionId, prInfo, useUltrathink });

    const response = await fetch('http://localhost:47382/answerQuestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.sessionId,
        prInfo,
        useUltrathink
      })
    });

    console.log('[AGENT-CLIENT] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('[AGENT-CLIENT] Result:', result);
    return result;
  }

  /**
   * Complete actions using Agent SDK
   */
  async completeActions(prInfo, useUltrathink = false) {
    if (!this.sessionId) {
      throw new Error('No session - call startSession() first');
    }

    console.log('[AGENT-CLIENT] Calling /completeActions with:', { sessionId: this.sessionId, prInfo, useUltrathink });

    const response = await fetch('http://localhost:47382/completeActions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.sessionId,
        prInfo,
        useUltrathink
      })
    });

    console.log('[AGENT-CLIENT] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('[AGENT-CLIENT] Result:', result);
    return result;
  }

  /**
   * Subscription mode: ask the server to open a visible `claude -p` window that
   * does the work and closes when done. No WebSocket / monitor panel involved.
   * @param {object} prInfo
   * @param {'questions'|'actions'} kind
   * @param {boolean} useUltrathink
   * @param {boolean|undefined} skipPermissions  One-off override for
   *        --dangerously-skip-permissions; undefined = use server setting.
   * @param {object} [repo]  Repo-location options:
   *        { repoPath, rememberPath, notInstalled }.
   */
  async runInteractive(prInfo, kind, useUltrathink = false, skipPermissions = undefined, repo = {}) {
    const response = await fetch('http://localhost:47382/runInteractive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prInfo, kind, useUltrathink, skipPermissions,
        repoPath: repo.repoPath,
        rememberPath: repo.rememberPath,
        notInstalled: repo.notInstalled
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server error: ${response.status} - ${errorText}`);
    }
    return response.json();
  }

  /**
   * Ask the server whether this repo already exists on disk.
   * @returns {Promise<{exists:boolean, path:string|null, defaultPath:string, projectsDir:string}>}
   */
  async checkRepo(fullRepoName) {
    const response = await fetch('http://localhost:47382/checkRepo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullRepoName })
    });
    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    return response.json();
  }

  /**
   * Send interrupt message to Claude
   */
  sendInterrupt(message) {
    console.log('[AGENT-CLIENT] Sending interrupt:', message);
    this.send({
      type: 'interrupt',
      message
    });
  }

  /**
   * Stop the agent (abort current task)
   */
  stopAgent() {
    console.log('[AGENT-CLIENT] Stopping agent');
    this.send({
      type: 'stop'
    });
  }
}

// Global instance
window.agentClient = new AgentClient();
