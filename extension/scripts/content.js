// Claude GitHub Buddy - Content Script
// Detects GitHub PR "Files changed" tab and adds Claude question UI

(function() {
  'use strict';

  // Simple hash function for code validation
  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  // Validate code hasn't changed since question/action creation
  function validateCode(entry) {
    try {
      // Find the file in the PR
      const files = GHAdapter.getAllFiles();
      for (const file of files) {
        const fileName = GHAdapter.getFileName(file);
        if (fileName === entry.file) {
          // Parse line numbers from entry.lines (e.g., "L29" or "L29-L35")
          const lineMatch = entry.lines.match(/L(\d+)(?:-L(\d+))?/);
          if (!lineMatch) return { status: 'unknown', currentCode: null };

          const startLine = lineMatch[1];
          const endLine = lineMatch[2] || startLine;

          // Get current code at those lines
          const currentCode = getCodeAtLines(file, startLine, endLine);
          if (!currentCode) return { status: 'missing', currentCode: null };

          // Compare hashes
          const currentHash = hashCode(currentCode);
          const originalHash = entry.codeHash;

          if (currentHash === originalHash) {
            return { status: 'valid', currentCode }; // ✅ Code unchanged
          } else if (currentCode.includes(entry.code.substring(0, Math.min(50, entry.code.length)))) {
            return { status: 'partial', currentCode }; // ⚠️ Code modified
          } else {
            return { status: 'invalid', currentCode }; // ❌ Code completely changed
          }
        }
      }
      return { status: 'file-not-found', currentCode: null };
    } catch (error) {
      console.error('Error validating code:', error);
      return { status: 'error', currentCode: null };
    }
  }

  // Get code at specific lines from a file element
  function getCodeAtLines(fileElement, startLine, endLine) {
    const codeLines = [];
    for (let lineNum = parseInt(startLine); lineNum <= parseInt(endLine); lineNum++) {
      const lineNumCell = GHAdapter.getLineCell(fileElement, lineNum);
      if (!lineNumCell) return null;

      const row = GHAdapter.getLineRow(lineNumCell);
      const codeCell = GHAdapter.getCodeCell(row);
      if (!codeCell) return null;

      const marker = GHAdapter.getCodeMarker(codeCell);
      const codeText = codeCell.textContent;
      codeLines.push(`${marker} ${codeText}`);
    }
    return codeLines.join('\n');
  }

  // Claude icon SVG - 20x20 container with eyes wider apart and higher up
  const CLAUDE_ICON_SVG = `<svg aria-hidden="true" focusable="false" class="octicon octicon-claude" viewBox="0 0 8 8" width="16" height="16" fill="currentColor" display="inline-block" overflow="visible" style="vertical-align:text-bottom;">
    <g fill="currentColor">
      <rect x="1.5" y="1" width="5" height="3.5"/>
      <rect x="0" y="2.25" width="1.5" height="1.25"/>
      <rect x="6.5" y="2.25" width="1.5" height="1.25"/>
      <rect x="1.5" y="4.5" width="1" height="1.5"/>
      <rect x="2.75" y="4.5" width="1" height="1.5"/>
      <rect x="4.25" y="4.5" width="1" height="1.5"/>
      <rect x="5.5" y="4.5" width="1" height="1.5"/>
    </g>
    <g fill="none" stroke="none">
      <rect x="2.5" y="2" width="0.75" height="1.25" fill="#f6f8fa"/>
      <rect x="4.75" y="2" width="0.75" height="1.25" fill="#f6f8fa"/>
    </g>
  </svg>`;

  // Dropdown triangle icon
  const TRIANGLE_DOWN_SVG = `<svg aria-hidden="true" focusable="false" class="octicon octicon-triangle-down" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" style="display:inline-block;overflow:visible;vertical-align:text-bottom;">
    <path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"></path>
  </svg>`;

  let currentSelection = null;
  let currentPRInfo = null;
  let copilotObserver = null; // Observer for Copilot button changes
  let lastCopilotPosition = null; // Track last known Copilot position
  let currentHoveredRow = null; // Track currently hovered row for non-selection questions
  let isClaudeButtonActive = false; // Track if Claude button or menu is being used
  let removeButtonTimeout = null; // Hover-bridge: delay button removal when leaving a line

  // Cancel a pending button removal (mouse came back to a line or onto the button).
  function cancelButtonRemoval() {
    if (removeButtonTimeout) {
      clearTimeout(removeButtonTimeout);
      removeButtonTimeout = null;
    }
  }

  // Schedule button removal after a short grace period. This bridges the tiny
  // gap between leaving a diff line and the mouse arriving on the Claude button,
  // so the button doesn't flicker out mid-move.
  function scheduleButtonRemoval() {
    if (removeButtonTimeout) return;
    removeButtonTimeout = setTimeout(() => {
      removeButtonTimeout = null;
      if (isClaudeButtonActive) return;
      const claudeButton = document.getElementById('claude-pr-buddy-button');
      if (claudeButton && !claudeButton.matches(':hover')) {
        removeClaudeButton();
        lastCopilotPosition = null;
        currentHoveredRow = null;
      }
    }, 250);
  }

  // Parse PR info from URL and page (delegated to GHAdapter for view-agnostic reads)
  function getPRInfo() {
    return GHAdapter.getPRInfo();
  }

  // Decide whether the Claude button should be on-screen, and where.
  //
  // The old approach piggy-backed on GitHub's per-line Copilot side menu
  // (`.DiffLinesMenu-module__diff-button-container--fFHPz` +
  // `[data-testid="copilot-ask-menu"]`). GitHub removed that side menu when
  // it introduced the `<copilot-diff-entry>` Web Component, so the anchor
  // never resolves. We now ask GHAdapter.findMountPosition() which picks the
  // best available anchor — primarily the currently-selected diff line.
  //
  // Function name kept for backwards-compat with the existing call sites.
  async function syncWithCopilotButton() {
    // While the user is interacting with the Claude button/menu, keep it pinned
    // where it is — don't let GitHub's ephemeral menu vanishing move it.
    if (isClaudeButtonActive) {
      const claudeButton = document.getElementById('claude-pr-buddy-button');
      if (claudeButton && lastCopilotPosition) {
        claudeButton.style.left = `${lastCopilotPosition.left}px`;
        claudeButton.style.top = `${lastCopilotPosition.top}px`;
      }
      return;
    }

    // The anchor is now DETERMINISTIC per row (stable gutter cell), so this can
    // run on every mutation/scroll without the button ever jumping sideways —
    // the X stays constant for a given row, only Y tracks scroll.
    const pos = GHAdapter.findMountPosition(currentHoveredRow);

    if (pos) {
      lastCopilotPosition = { left: pos.left, top: pos.top };

      let claudeButton = document.getElementById('claude-pr-buddy-button');
      if (!claudeButton) {
        await createClaudeButton();
        claudeButton = document.getElementById('claude-pr-buddy-button');
      }

      if (claudeButton) {
        claudeButton.style.left = `${lastCopilotPosition.left}px`;
        claudeButton.style.top = `${lastCopilotPosition.top}px`;
      }
    }
    // No anchor: removal is handled by the hover-bridge scheduler, not here, so
    // the button survives the brief move from a diff line onto itself.
  }

  // Handle selection for question capture
  function handleSelection(event) {
    const highlightedLines = GHAdapter.getSelectedLines();

    if (highlightedLines.length > 0) {
      console.log(`Found ${highlightedLines.length} selected lines`);
      handlePermalinkSelection(highlightedLines);
    }
  }

  // Handle GitHub's permalink selection (yellow highlight)
  function handlePermalinkSelection(highlightedLines) {
    const lines = Array.from(highlightedLines);

    // Build code text with diff markers
    const codeLines = [];
    const lineNumbers = [];

    lines.forEach(line => {
      const row = GHAdapter.getLineRow(line);
      const codeInner = GHAdapter.getCodeCell(row) ||
                        (line.matches('.blob-code-inner') ? line : line.querySelector('.blob-code-inner'));
      if (!codeInner) return;

      const marker = GHAdapter.getCodeMarker(codeInner);
      const codeText = codeInner.textContent;
      codeLines.push(`${marker} ${codeText}`);

      const lineNumCell = GHAdapter.getRightLineNum(row);
      const lineNum = lineNumCell?.getAttribute('data-line-number');
      if (lineNum) lineNumbers.push(lineNum);
    });

    const codeText = codeLines.join('\n');

    if (!codeText.trim()) {
      removeClaudeButton();
      return;
    }

    // Get file name from the first highlighted line
    const firstLine = lines[0];
    const file = getFileNameFromDiff(firstLine);

    // Format line numbers
    const lineRange = lineNumbers.length > 0
      ? (lineNumbers.length === 1
          ? `L${lineNumbers[0]}`
          : `L${lineNumbers[0]}-L${lineNumbers[lineNumbers.length - 1]}`)
      : 'unknown';

    currentSelection = {
      text: codeText,
      file: file,
      lineNumbers: lineRange
    };

    console.log('Selection:', currentSelection);
  }

  function getFileNameFromDiff(element) {
    return GHAdapter.getFileName(GHAdapter.findFileFromLine(element));
  }

  // Create the Claude button (called by syncWithCopilotButton)
  async function createClaudeButton() {
    console.log('[BUTTON] Creating new Claude button');

    // If Claude was already active, show fake immediately (mouse already over Claude area)
    const wasActive = isClaudeButtonActive;

    // Get user preference for default action
    const result = await chrome.storage.local.get('default_button_action');
    const defaultAction = result.default_button_action || 'question';

    // Set tooltip text based on preference
    const mainTooltipText = defaultAction === 'action'
      ? 'Get Claude to change this file'
      : 'Ask Claude about this file-diff';

    // Create split button (single unified bubble)
    const buttonGroup = document.createElement('div');
    buttonGroup.id = 'claude-pr-buddy-button';

    // Split button HTML - left button (icon) + right button (dropdown)
    buttonGroup.innerHTML = `
      <div class="claude-button-wrapper">
        <button type="button" class="claude-main-button">
          ${CLAUDE_ICON_SVG}
        </button>
      </div>
      <div class="claude-button-wrapper">
        <button type="button" class="claude-dropdown-button" aria-haspopup="true" aria-expanded="false">
          ${TRIANGLE_DOWN_SVG}
        </button>
      </div>
    `;

    // Initial positioning (will be updated by syncWithCopilotButton)
    buttonGroup.style.position = 'absolute';
    buttonGroup.style.zIndex = '100';

    // Main button click - open question or action dialog based on settings
    const mainButton = buttonGroup.querySelector('.claude-main-button');
    mainButton.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDropdownMenu();

      // Check user preference for default action
      const result = await chrome.storage.local.get('default_button_action');
      const defaultAction = result.default_button_action || 'question';

      if (defaultAction === 'action') {
        showActionDialog(null, null);
      } else {
        showQuestionDialog();
      }
    });

    // Dropdown button click - toggle menu
    const dropdownButton = buttonGroup.querySelector('.claude-dropdown-button');
    dropdownButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleDropdownMenu(dropdownButton);
    });

    document.body.appendChild(buttonGroup);

    // Track when Claude button is being interacted with
    buttonGroup.addEventListener('mouseenter', () => {
      isClaudeButtonActive = true;
      showFakeCopilot();
    });

    buttonGroup.addEventListener('mouseleave', () => {
      // Only deactivate if menu is not open
      const menu = document.getElementById('claude-dropdown-menu');
      if (!menu) {
        isClaudeButtonActive = false;
        hideFakeCopilot();
      }
    });

    // Add GitHub-style tooltips using their tooltip system
    addGitHubTooltips(mainButton, dropdownButton, mainTooltipText);

    // If Claude was active before recreation, show fake again
    if (wasActive) {
      showFakeCopilot();
    }
  }


  function addGitHubTooltips(mainButton, dropdownButton, mainTooltipText = 'Ask Claude about this file-diff') {
    // Create tooltip elements using GitHub's Primer tooltip classes
    const mainTooltipId = 'claude-main-tooltip-' + Date.now();
    const dropdownTooltipId = 'claude-dropdown-tooltip-' + Date.now();

    // Main button tooltip
    const mainTooltip = document.createElement('span');
    mainTooltip.className = 'prc-TooltipV2-Tooltip-cYMVY';
    mainTooltip.setAttribute('data-direction', 'nw');
    mainTooltip.setAttribute('aria-hidden', 'true');
    mainTooltip.setAttribute('id', mainTooltipId);
    mainTooltip.setAttribute('popover', 'auto');
    mainTooltip.textContent = mainTooltipText;
    mainButton.setAttribute('aria-labelledby', mainTooltipId);
    mainButton.parentElement.appendChild(mainTooltip);

    // Dropdown button tooltip
    const dropdownTooltip = document.createElement('span');
    dropdownTooltip.className = 'prc-TooltipV2-Tooltip-cYMVY';
    dropdownTooltip.setAttribute('data-direction', 'nw');
    dropdownTooltip.setAttribute('aria-hidden', 'true');
    dropdownTooltip.setAttribute('id', dropdownTooltipId);
    dropdownTooltip.setAttribute('popover', 'auto');
    dropdownTooltip.textContent = 'Claude PR Helper Menu';
    dropdownButton.setAttribute('aria-labelledby', dropdownTooltipId);
    dropdownButton.parentElement.appendChild(dropdownTooltip);

    // Position and show/hide tooltips on hover (manual positioning like GitHub does)
    const showTooltip = (button, tooltip, direction) => {
      console.log(`[TOOLTIP] showTooltip called - direction: ${direction}, tooltip.id: ${tooltip.id}`);

      const rect = button.getBoundingClientRect();

      // Set position properties BEFORE showing
      tooltip.style.position = 'absolute';
      tooltip.style.pointerEvents = 'none';
      tooltip.style.zIndex = '10003';

      console.log(`[TOOLTIP] About to call showPopover()`);

      // Show popover first (required for measurement)
      try {
        tooltip.showPopover();
        console.log(`[TOOLTIP] showPopover() successful`);
      } catch (e) {
        console.log(`[TOOLTIP] showPopover() error: ${e.message}`);
        return;
      }

      // Measure after showing
      const tooltipRect = tooltip.getBoundingClientRect();
      console.log(`[TOOLTIP] Measured tooltip: width=${tooltipRect.width}, height=${tooltipRect.height}`);

      let top, left;

      if (direction === 'above') {
        // Main button: Position above and to the left (northwest)
        top = rect.top + window.scrollY - tooltipRect.height - 4;
        left = rect.right - tooltipRect.width;
      } else {
        // Dropdown button: Position below and to the left (southwest)
        top = rect.bottom + window.scrollY + 4;
        left = rect.right - tooltipRect.width;
      }

      console.log(`[TOOLTIP] Positioning at top=${top}, left=${left}`);

      // Position tooltip
      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;

      console.log(`[TOOLTIP] showTooltip complete`);
    };

    const hideTooltip = (tooltip) => {
      console.log(`[TOOLTIP] hideTooltip called for ${tooltip.id}`);
      try {
        tooltip.hidePopover();
        console.log(`[TOOLTIP] hidePopover() successful`);
      } catch (e) {
        console.log(`[TOOLTIP] hidePopover() error: ${e.message}`);
      }
    };

    // Track hover state to prevent flickering
    let mainHoverTimeout, dropdownHoverTimeout;
    let mainShowTimeout, dropdownShowTimeout;

    mainButton.addEventListener('mouseenter', () => {
      console.log(`[TOOLTIP] Main button mouseenter`);
      clearTimeout(mainHoverTimeout);
      clearTimeout(mainShowTimeout);
      // Small delay to let other tooltips close first (prevents flash when moving from Copilot)
      mainShowTimeout = setTimeout(() => {
        console.log(`[TOOLTIP] Main button show timeout fired`);
        showTooltip(mainButton, mainTooltip, 'above');
      }, 50);
    });

    mainButton.addEventListener('mouseleave', () => {
      console.log(`[TOOLTIP] Main button mouseleave`);
      clearTimeout(mainShowTimeout);
      mainHoverTimeout = setTimeout(() => {
        console.log(`[TOOLTIP] Main button hide timeout fired`);
        hideTooltip(mainTooltip);
      }, 100);
    });

    dropdownButton.addEventListener('mouseenter', () => {
      console.log(`[TOOLTIP] Dropdown button mouseenter`);
      clearTimeout(dropdownHoverTimeout);
      clearTimeout(dropdownShowTimeout);
      // Small delay to let other tooltips close first (prevents flash when moving from Copilot)
      dropdownShowTimeout = setTimeout(() => {
        console.log(`[TOOLTIP] Dropdown button show timeout fired`);
        showTooltip(dropdownButton, dropdownTooltip, 'below');
      }, 50);
    });

    dropdownButton.addEventListener('mouseleave', () => {
      console.log(`[TOOLTIP] Dropdown button mouseleave`);
      clearTimeout(dropdownShowTimeout);
      dropdownHoverTimeout = setTimeout(() => {
        console.log(`[TOOLTIP] Dropdown button hide timeout fired`);
        hideTooltip(dropdownTooltip);
      }, 100);
    });
  }

  function removeClaudeButton() {
    const existing = document.getElementById('claude-pr-buddy-button');
    if (existing) existing.remove();
    closeDropdownMenu();
    hideFakeCopilot();

    // Remove any orphaned tooltips
    document.querySelectorAll('[id^="claude-main-tooltip-"], [id^="claude-dropdown-tooltip-"]').forEach(el => el.remove());
  }

  let hideFakeTimeout = null;

  function showFakeCopilot() {
    // Cancel any pending hide operation
    if (hideFakeTimeout) {
      clearTimeout(hideFakeTimeout);
      hideFakeTimeout = null;
    }

    // Remove any existing fake first (in case of position change)
    const existingFake = document.getElementById('claude-fake-copilot');
    if (existingFake) {
      existingFake.remove();
    }

    // Find the real Copilot button
    const realCopilot = document.querySelector('[data-testid="copilot-ask-menu"]');
    if (!realCopilot) return;

    const copilotContainer = realCopilot.closest('.DiffLinesMenu-module__diff-button-container--fFHPz');
    if (!copilotContainer) return;

    // Get the real Copilot's position
    const rect = copilotContainer.getBoundingClientRect();

    // Clone and create fake
    const fakeCopilot = copilotContainer.cloneNode(true);
    fakeCopilot.id = 'claude-fake-copilot';

    // Make it non-interactive (visual only)
    fakeCopilot.style.pointerEvents = 'none';
    fakeCopilot.style.position = 'fixed'; // Use fixed positioning (viewport coordinates)
    fakeCopilot.style.zIndex = '99'; // Below Claude (100) but above content
    fakeCopilot.style.transform = 'none'; // Clear any transforms from the clone

    // Position at real Copilot's location (viewport coordinates)
    fakeCopilot.style.left = `${rect.left}px`;
    fakeCopilot.style.top = `${rect.top}px`;

    document.body.appendChild(fakeCopilot);
  }

  function hideFakeCopilot() {
    // Small delay before removing fake to let real Copilot appear first (prevents flash)
    hideFakeTimeout = setTimeout(() => {
      const fake = document.getElementById('claude-fake-copilot');
      if (fake) {
        fake.remove();
      }
      hideFakeTimeout = null;
    }, 50);
  }

  function toggleDropdownMenu(buttonElement) {
    const existingMenu = document.getElementById('claude-dropdown-menu');

    if (existingMenu) {
      closeDropdownMenu();
      return;
    }

    // Get button position
    const buttonRect = buttonElement.getBoundingClientRect();

    // Create dropdown menu
    const menu = document.createElement('div');
    menu.id = 'claude-dropdown-menu';

    menu.innerHTML = `
      <div class="prc-ActionMenu-ActionMenuContainer-XdFHv">
        <ul role="menu">
          <li tabindex="0" role="menuitem" class="claude-menu-item" data-action="ask">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Ask Claude</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="markAction">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Mark for Action</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="restoreFromFile">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Restore from File</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="refreshQuestionsActions">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Refresh Questions/Actions</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="resetClaudeState">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Reset Claude state (unstick buttons)</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="settings">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Settings</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="clearQuestions">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Clear All Questions</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="clearActions">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Clear All Actions</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="clearEverything">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Clear Everything</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="copyQuestionsPath">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Copy Questions Path</span>
              </span>
            </div>
          </li>
          <li class="prc-ActionList-Divider-rsZFG" aria-hidden="true"></li>
          <li tabindex="-1" role="menuitem" class="claude-menu-item" data-action="copyActionsPath">
            <div class="prc-ActionList-ActionListContent-sg9-x">
              <span class="prc-ActionList-Spacer-dydlX"></span>
              <span class="prc-ActionList-ActionListSubContent-lP9xj">
                <span class="prc-ActionList-ItemLabel-TmBhn">Copy Actions Path</span>
              </span>
            </div>
          </li>
        </ul>
      </div>
    `;

    // Position menu below the button, but keep it within window bounds
    const windowWidth = window.innerWidth;
    const menuWidth = 180; // min-width from CSS

    let left = buttonRect.left;
    let top = buttonRect.bottom + window.scrollY;

    // If menu would go off right edge, align it to the right of the button instead
    if (left + menuWidth > windowWidth) {
      left = buttonRect.right - menuWidth;
    }

    // Ensure menu doesn't go off left edge either
    if (left < 0) {
      left = 8; // 8px margin from edge
    }

    menu.style.position = 'absolute';
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.zIndex = '10001';

    document.body.appendChild(menu);

    // Keep active state while menu is open
    menu.addEventListener('mouseenter', () => {
      isClaudeButtonActive = true;
      showFakeCopilot();
    });

    menu.addEventListener('mouseleave', () => {
      isClaudeButtonActive = false;
      hideFakeCopilot();
    });

    // Add click handlers to menu items
    menu.querySelectorAll('.claude-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        handleMenuAction(action);
        closeDropdownMenu();
      });
    });

    // Close menu when clicking outside
    setTimeout(() => {
      document.addEventListener('click', closeDropdownMenu, { once: true });
    }, 0);
  }

  function closeDropdownMenu() {
    const menu = document.getElementById('claude-dropdown-menu');
    if (menu) menu.remove();

    // Reset active state when menu closes
    isClaudeButtonActive = false;
  }

  // Escape hatch: force-clear any stuck interactive run and reset both action
  // buttons to idle. Cancels in-flight polls via the generation bump.
  function resetClaudeState() {
    window._claudeRunGen = (window._claudeRunGen || 0) + 1;
    window._claudeInteractiveBusy = false;
    if (typeof window._claudeCancelRun === 'function') {
      try { window._claudeCancelRun(); } catch {}
    }
    ['claude-answer-questions-btn', 'claude-complete-actions-btn'].forEach(id => {
      const b = document.getElementById(id);
      if (b) {
        b.disabled = false;
        b.onclick = null;
        b.removeAttribute('data-state');
        b.innerHTML = id === 'claude-answer-questions-btn' ? 'Answer Questions' : 'Start Actions';
      }
    });
    showNotification('🔄 Claude state reset — buttons are ready again.');
  }

  function handleMenuAction(action) {
    switch (action) {
      case 'ask':
        showQuestionDialog();
        break;
      case 'markAction':
        showActionDialog(null, null); // Ad-hoc action (no question linked)
        break;
      case 'restoreFromFile':
        showRestoreFromFileDialog();
        break;
      case 'refreshQuestionsActions':
        refreshQuestionsAndActions();
        break;
      case 'resetClaudeState':
        resetClaudeState();
        break;
      case 'settings':
        showSettingsDialog();
        break;
      case 'clearQuestions':
        clearQuestionsFromMenu();
        break;
      case 'clearActions':
        clearActionsFromMenu();
        break;
      case 'clearEverything':
        clearEverythingFromMenu();
        break;
      case 'copyQuestionsPath':
        copyQuestionsPath();
        break;
      case 'copyActionsPath':
        copyActionsPath();
        break;
    }
  }

  async function refreshAnswersFromFile() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return;

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'importFromMarkdown',
        prInfo: currentPRInfo
      }, (response) => {
        if (response && response.success) {
          // Clear existing inline comments and reload
          document.querySelectorAll('.claude-inline-comment-row').forEach(el => el.remove());
          loadAndDisplayAnswers();
          resolve();
        } else {
          console.error('Failed to refresh answers:', response?.error);
          reject(new Error(response?.error || 'Failed to refresh answers'));
        }
      });
    });
  }

  /**
   * Refresh all questions and actions from files and re-render inline comments
   * Useful when inline comments fail to render on large PRs
   */
  async function refreshQuestionsAndActions() {
    console.log('[REFRESH] Clearing existing inline comments and reloading from files...');

    // Clear all existing inline comment rows
    document.querySelectorAll('.claude-inline-comment-row').forEach(el => el.remove());

    // Re-sync from files and display
    try {
      await autoRestoreFromFiles();
      loadAndDisplayAnswers();
      loadAndDisplayActions();
      showNotification('✅ Questions and actions refreshed!');
    } catch (error) {
      console.error('[REFRESH] Error refreshing:', error);
      showNotification('❌ Failed to refresh: ' + error.message);
    }
  }

  async function clearQuestionsFromMenu() {
    if (!confirm('Clear all questions for this PR? This will delete them from browser memory (the markdown file will be archived first).')) {
      return;
    }
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return;

    // Archive the questions file first
    const repoName = currentPRInfo.fullRepoName.split('/')[1];
    const prFolder = `PR-${currentPRInfo.prNumber}`;
    const dateStr = new Date().toISOString().split('T')[0];
    const questionsFilename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;

    chrome.runtime.sendMessage({
      action: 'archiveFile',
      filename: questionsFilename
    });

    const storageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    await chrome.storage.local.remove(storageKey);
    await chrome.storage.local.remove(`pr_meta_${storageKey}`);

    // Clear the questions file
    chrome.runtime.sendMessage({
      action: 'exportToMarkdown',
      prInfo: currentPRInfo,
      questions: []
    });

    // Remove all question boxes from DOM
    document.querySelectorAll('.claude-inline-comment-row').forEach(el => {
      const commentDiv = el.querySelector('.claude-inline-comment');
      if (commentDiv && !commentDiv.classList.contains('claude-action-box')) {
        el.remove();
      }
    });

    showNotification('✅ Questions archived and cleared!');
  }

  /**
   * Verify all questions have been answered
   */
  async function verifyAllQuestionsAnswered() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return false;

    const repoName = currentPRInfo.fullRepoName.split('/')[1];
    const prFolder = `PR-${currentPRInfo.prNumber}`;
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;

    console.log('[VERIFY] Checking file:', filename);

    try {
      const response = await fetch('http://localhost:47382/readFile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });

      console.log('[VERIFY] Response status:', response.status);

      if (!response.ok) {
        console.log('[VERIFY] File read failed');
        return false;
      }

      const result = await response.json();
      const content = result.content;

      console.log('[VERIFY] Content length:', content.length);

      // Check if there are QUESTION sections without filled ANSWER sections
      const questionBlocks = content.split(/##\s+Question\s+\d+/);

      console.log('[VERIFY] Found question blocks:', questionBlocks.length - 1);

      for (const block of questionBlocks) {
        if (!block.trim()) continue;

        // If there's a QUESTION but no substantial ANSWER (or just placeholder), fail
        if (block.includes('**QUESTION:**')) {
          const answerMatch = block.match(/\*\*ANSWER:\*\*\s*([^#-]*)/s);
          if (!answerMatch) {
            console.log('[VERIFY] No ANSWER section found');
            return false;
          }

          const answer = answerMatch[1].trim();
          console.log('[VERIFY] Answer preview:', answer.substring(0, 80) + '...');

          // Check if answer is placeholder or too short
          if (answer.length < 10 ||
              answer.includes('[Claude, please fill in') ||
              answer.includes('_[Answer pending]_') ||
              answer.startsWith('_[')) {
            console.log('[VERIFY] Question failed - placeholder or too short');
            return false;
          }
        }
      }

      console.log('[VERIFY] All questions answered!');
      return true;
    } catch (error) {
      console.error('[VERIFY] Error checking questions:', error);
      return false;
    }
  }

  /**
   * Verify all actions have summaries filled in
   */
  async function verifyAllActionsCompleted() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return false;

    const repoName = currentPRInfo.fullRepoName.split('/')[1];
    const prFolder = `PR-${currentPRInfo.prNumber}`;
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;

    console.log('[VERIFY-ACTIONS] Checking file:', filename);

    try {
      const response = await fetch('http://localhost:47382/readFile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });

      console.log('[VERIFY-ACTIONS] Response status:', response.status);

      if (!response.ok) {
        console.log('[VERIFY-ACTIONS] File read failed');
        return false;
      }

      const result = await response.json();
      const content = result.content;

      console.log('[VERIFY-ACTIONS] Content length:', content.length);

      // Check if there are ACTION sections without filled SUMMARY sections
      const actionBlocks = content.split(/##\s+Action\s+\d+/);

      console.log('[VERIFY-ACTIONS] Found action blocks:', actionBlocks.length - 1);

      for (const block of actionBlocks) {
        if (!block.trim()) continue;

        // If there's an ACTION but no substantial SUMMARY (or just placeholder), fail
        if (block.includes('**ACTION:**')) {
          const summaryMatch = block.match(/\*\*SUMMARY:\*\*\s*([^#-]*)/s);
          if (!summaryMatch) {
            console.log('[VERIFY-ACTIONS] No SUMMARY section found');
            return false;
          }

          const summary = summaryMatch[1].trim();
          console.log('[VERIFY-ACTIONS] Summary preview:', summary.substring(0, 80) + '...');

          // Check if summary is placeholder or too short
          if (summary.length < 10 ||
              summary.includes('[Claude, please fill in') ||
              summary.includes('_[Action summary pending]_') ||
              summary.startsWith('_[')) {
            console.log('[VERIFY-ACTIONS] Action failed - placeholder or too short');
            return false;
          }
        }
      }

      console.log('[VERIFY-ACTIONS] All actions completed!');
      return true;
    } catch (error) {
      console.error('[VERIFY] Error checking actions:', error);
      return false;
    }
  }

  /**
   * Archive actions file without user confirmation (called after completion)
   */
  async function archiveActionsFile() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return;

    const repoName = currentPRInfo.fullRepoName.split('/')[1];
    const prFolder = `PR-${currentPRInfo.prNumber}`;
    const dateStr = new Date().toISOString().split('T')[0];
    const actionsFilename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;

    chrome.runtime.sendMessage({
      action: 'archiveFile',
      filename: actionsFilename
    });
  }

  /**
   * Clear all actions from memory and DOM (called after completion)
   */
  async function clearAllActions() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return;

    const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    await chrome.storage.local.remove(storageKey);

    // Clear the actions file
    chrome.runtime.sendMessage({
      action: 'exportToActions',
      prInfo: currentPRInfo,
      actions: []
    });

    // Remove all action boxes from DOM
    document.querySelectorAll('.claude-inline-comment-row').forEach(el => {
      const commentDiv = el.querySelector('.claude-inline-comment');
      if (commentDiv && commentDiv.classList.contains('claude-action-box')) {
        el.remove();
      }
    });

    // Reset in-memory actions array
    actions = [];
  }

  async function clearActionsFromMenu() {
    if (!confirm('Clear all actions for this PR? This will delete them from browser memory (the markdown file will be archived first).')) {
      return;
    }
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return;

    // Archive the actions file first
    const repoName = currentPRInfo.fullRepoName.split('/')[1];
    const prFolder = `PR-${currentPRInfo.prNumber}`;
    const dateStr = new Date().toISOString().split('T')[0];
    const actionsFilename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;

    chrome.runtime.sendMessage({
      action: 'archiveFile',
      filename: actionsFilename
    });

    const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    await chrome.storage.local.remove(storageKey);

    // Update markdown file with empty actions array
    chrome.runtime.sendMessage({
      action: 'exportToActions',
      prInfo: currentPRInfo,
      actions: []
    });

    // Remove all action boxes from DOM and revert question-linked ones to normal questions
    document.querySelectorAll('.claude-inline-comment-row').forEach(el => {
      const commentDiv = el.querySelector('.claude-inline-comment');
      if (commentDiv && commentDiv.classList.contains('claude-action-box')) {
        // Check if this is question-linked or ad-hoc
        const actionSection = el.querySelector('.claude-action-section');
        if (actionSection) {
          // Question-linked - remove action section and styling
          actionSection.remove();
          commentDiv.classList.remove('claude-action-box');

          // Restore original question header (would need to re-fetch question data)
          // For now, just reload the page to refresh
          location.reload();
        } else {
          // Ad-hoc action - just remove it
          el.remove();
        }
      }
    });

    showNotification('✅ Actions archived and cleared!');
  }

  async function clearEverythingFromMenu() {
    if (!confirm('Clear ALL questions AND actions for this PR? This will delete them from browser memory (the markdown files will be archived first).')) {
      return;
    }
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return;

    // Archive both files first
    const repoName = currentPRInfo.fullRepoName.split('/')[1];
    const prFolder = `PR-${currentPRInfo.prNumber}`;
    const dateStr = new Date().toISOString().split('T')[0];
    const questionsFilename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;
    const actionsFilename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;

    chrome.runtime.sendMessage({
      action: 'archiveFile',
      filename: questionsFilename
    });

    chrome.runtime.sendMessage({
      action: 'archiveFile',
      filename: actionsFilename
    });

    // Clear questions
    const questionStorageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    await chrome.storage.local.remove(questionStorageKey);
    await chrome.storage.local.remove(`pr_meta_${questionStorageKey}`);

    // Clear actions
    const actionStorageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    await chrome.storage.local.remove(actionStorageKey);

    // Update markdown files
    chrome.runtime.sendMessage({
      action: 'exportToMarkdown',
      prInfo: currentPRInfo,
      questions: []
    });

    chrome.runtime.sendMessage({
      action: 'exportToActions',
      prInfo: currentPRInfo,
      actions: []
    });

    // Remove all inline comment rows from DOM
    document.querySelectorAll('.claude-inline-comment-row').forEach(el => el.remove());

    showNotification('✅ Everything archived and cleared!');
  }

  async function copyQuestionsPath() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) {
      showNotification('❌ Could not detect PR information');
      return;
    }

    try {
      // Get config from server to get the base directory
      const configResponse = await fetch('http://localhost:47382/getConfig');
      const configData = await configResponse.json();

      if (!configData.success) {
        showNotification('❌ Failed to get server configuration');
        return;
      }

      const prReviewsDir = configData.config?.prReviewsDir;
      if (!prReviewsDir) {
        showNotification('❌ Server configuration missing prReviewsDir');
        return;
      }

      // Build file path
      const repoName = currentPRInfo.fullRepoName.split('/')[1];
      const prFolder = `PR-${currentPRInfo.prNumber}`;
      const dateStr = new Date().toISOString().split('T')[0];
      const questionsFilename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;
      const fullPath = `${prReviewsDir}/${questionsFilename}`;

      // Check if file exists by trying to read it
      const response = await fetch('http://localhost:47382/readFile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: questionsFilename })
      });

      if (!response.ok) {
        showNotification('❌ Questions file for today does not exist');
        return;
      }

      // File exists, copy path to clipboard
      await navigator.clipboard.writeText(fullPath);
      showNotification(`✅ Copied: ${fullPath}`);
    } catch (error) {
      console.error('[COPY-PATH] Error:', error);
      showNotification(`❌ Failed to copy path: ${error.message}`);
    }
  }

  async function copyActionsPath() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) {
      showNotification('❌ Could not detect PR information');
      return;
    }

    try {
      // Get config from server to get the base directory
      const configResponse = await fetch('http://localhost:47382/getConfig');
      const configData = await configResponse.json();

      if (!configData.success) {
        showNotification('❌ Failed to get server configuration');
        return;
      }

      const prReviewsDir = configData.config?.prReviewsDir;
      if (!prReviewsDir) {
        showNotification('❌ Server configuration missing prReviewsDir');
        return;
      }

      // Build file path
      const repoName = currentPRInfo.fullRepoName.split('/')[1];
      const prFolder = `PR-${currentPRInfo.prNumber}`;
      const dateStr = new Date().toISOString().split('T')[0];
      const actionsFilename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;
      const fullPath = `${prReviewsDir}/${actionsFilename}`;

      // Check if file exists by trying to read it
      const response = await fetch('http://localhost:47382/readFile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: actionsFilename })
      });

      if (!response.ok) {
        showNotification('❌ Actions file for today does not exist');
        return;
      }

      // File exists, copy path to clipboard
      await navigator.clipboard.writeText(fullPath);
      showNotification(`✅ Copied: ${fullPath}`);
    } catch (error) {
      console.error('[COPY-PATH] Error:', error);
      showNotification(`❌ Failed to copy path: ${error.message}`);
    }
  }

  function showRestoreFromFileDialog() {
    const dialog = document.createElement('div');
    dialog.id = 'claude-restore-dialog';
    dialog.className = 'claude-dialog';
    dialog.innerHTML = `
      <div class="claude-dialog-content">
        <h3>Restore from File</h3>
        <p style="margin-bottom: 16px; color: #656d76; font-size: 14px;">
          Select a Questions or Actions markdown file to restore its contents to browser memory.
        </p>
        <input type="file" id="claude-restore-file-input" accept=".md" style="margin-bottom: 16px; width: 100%;">
        <div class="dialog-buttons">
          <button id="claude-restore-file">Restore</button>
          <button id="claude-cancel-restore">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    document.getElementById('claude-restore-file').addEventListener('click', () => {
      const fileInput = document.getElementById('claude-restore-file-input');
      const file = fileInput.files[0];

      if (!file) {
        alert('Please select a file first.');
        return;
      }

      if (!file.name.endsWith('.md')) {
        alert('Please select a markdown (.md) file.');
        return;
      }

      restoreFromFile(file);
      dialog.remove();
    });

    document.getElementById('claude-cancel-restore').addEventListener('click', () => {
      dialog.remove();
    });
  }

  async function restoreFromFile(file) {
    const reader = new FileReader();

    reader.onload = async (e) => {
      const content = e.target.result;

      // Detect if this is a Questions or Actions file
      const isQuestionsFile = content.includes('**QUESTION:**') || file.name.includes('Questions');
      const isActionsFile = content.includes('**ACTION:**') || file.name.includes('Actions');

      if (!isQuestionsFile && !isActionsFile) {
        alert('Could not detect file type. Please select a Questions or Actions markdown file.');
        return;
      }

      currentPRInfo = getPRInfo();
      if (!currentPRInfo) {
        alert('Could not detect PR information');
        return;
      }

      try {
        if (isQuestionsFile) {
          // Parse questions from markdown
          const parsed = parseQuestionsMarkdown(content);

          // Get existing questions from storage
          const storageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
          const existingData = await chrome.storage.local.get(storageKey);
          const existing = existingData[storageKey] || [];

          // Merge parsed with existing (additive)
          // Use a Set to track unique questions by file+lines
          const uniqueKeys = new Set(existing.map(q => `${q.file}:${q.lines}`));
          const newQuestions = parsed.filter(q => !uniqueKeys.has(`${q.file}:${q.lines}`));

          const merged = [...existing, ...newQuestions];
          await chrome.storage.local.set({ [storageKey]: merged });

          // Also store PR metadata
          await chrome.storage.local.set({
            [`pr_meta_${storageKey}`]: {
              repo: currentPRInfo.fullRepoName,
              prTitle: currentPRInfo.prTitle,
              prNumber: currentPRInfo.prNumber,
              baseBranch: currentPRInfo.baseBranch,
              headBranch: currentPRInfo.headBranch
            }
          });

          // Clear existing question boxes and reload with merged data
          document.querySelectorAll('.claude-inline-comment-row').forEach(el => {
            const commentDiv = el.querySelector('.claude-inline-comment');
            if (commentDiv && !commentDiv.classList.contains('claude-action-box')) {
              el.remove();
            }
          });

          // Display all questions inline (existing + new)
          merged.forEach((entry, index) => {
            displayQuestionInline(entry, index);
          });

          if (newQuestions.length > 0) {
            showNotification(`✅ Added ${newQuestions.length} new questions (${existing.length} already existed)`);
          } else {
            showNotification(`ℹ️ No new questions to add (all ${existing.length} already existed)`);
          }
        } else if (isActionsFile) {
          // Parse actions from markdown
          const parsed = parseActionsMarkdown(content);

          // Get existing actions from storage
          const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
          const existingData = await chrome.storage.local.get(storageKey);
          const existing = existingData[storageKey] || [];

          // Merge parsed with existing (additive)
          // Use a Set to track unique actions by file+lines
          const uniqueKeys = new Set(existing.map(a => `${a.file}:${a.lines}`));
          const newActions = parsed.filter(a => !uniqueKeys.has(`${a.file}:${a.lines}`));

          const merged = [...existing, ...newActions];
          await chrome.storage.local.set({ [storageKey]: merged });

          // Clear existing action boxes and reload with merged data
          document.querySelectorAll('.claude-inline-comment-row').forEach(el => {
            const commentDiv = el.querySelector('.claude-inline-comment');
            if (commentDiv && commentDiv.classList.contains('claude-action-box')) {
              el.remove();
            }
          });

          // Display all actions inline (existing + new)
          merged.forEach((entry, index) => {
            displayActionInline(entry, index, entry.questionIndex);
          });

          if (newActions.length > 0) {
            showNotification(`✅ Added ${newActions.length} new actions (${existing.length} already existed)`);
          } else {
            showNotification(`ℹ️ No new actions to add (all ${existing.length} already existed)`);
          }
        }
      } catch (error) {
        console.error('Error restoring from file:', error);
        alert('Failed to restore from file: ' + error.message);
      }
    };

    reader.readAsText(file);
  }

  function parseQuestionsMarkdown(content) {
    const questions = [];
    const questionBlocks = content.split(/##\s+Question\s+\d+/);

    questionBlocks.slice(1).forEach(block => {
      const fileMatch = block.match(/\*\*File:\*\*\s*`([^`]+)`/);
      const linesMatch = block.match(/\*\*Lines:\*\*\s*([^\n]+)/);
      const timestampMatch = block.match(/\*\*Timestamp:\*\*\s*([^\n]+)/);
      const codeMatch = block.match(/\*\*Code:\*\*\s*```([^`]+)```/s);
      const questionMatch = block.match(/\*\*QUESTION:\*\*\s*([^*]+?)\s*\*\*ANSWER:\*\*/s);
      const answerMatch = block.match(/\*\*ANSWER:\*\*\s*(.+?)(?=---|$)/s);

      if (fileMatch && questionMatch) {
        const answer = answerMatch ? answerMatch[1].trim() : '';
        const code = codeMatch ? codeMatch[1].trim() : '';
        questions.push({
          file: fileMatch[1],
          lines: linesMatch ? linesMatch[1].trim() : 'unknown',
          timestamp: timestampMatch ? timestampMatch[1].trim() : new Date().toISOString(),
          code: code,
          codeHash: code ? hashCode(code) : undefined, // Calculate hash for validation
          question: questionMatch[1].trim(),
          answer: answer && !answer.includes('[Claude, please fill') ? answer : undefined
        });
      }
    });

    return questions;
  }

  function parseActionsMarkdown(content) {
    const actions = [];
    const actionBlocks = content.split(/##\s+Action\s+\d+/);

    actionBlocks.slice(1).forEach(block => {
      const fileMatch = block.match(/\*\*File:\*\*\s*`([^`]+)`/);
      const linesMatch = block.match(/\*\*Lines:\*\*\s*([^\n]+)/);
      const timestampMatch = block.match(/\*\*Timestamp:\*\*\s*([^\n]+)/);
      const typeMatch = block.match(/\*\*Type:\*\*\s*([^\n]+)/);
      const codeMatch = block.match(/\*\*Code:\*\*\s*```([^`]+)```/s);
      const questionMatch = block.match(/\*\*ORIGINAL QUESTION:\*\*\s*([^*]+?)(?=\*\*ORIGINAL ANSWER:|\*\*ACTION:)/s);
      const answerMatch = block.match(/\*\*ORIGINAL ANSWER:\*\*\s*([^*]+?)(?=\*\*ACTION:)/s);
      const actionMatch = block.match(/\*\*ACTION:\*\*\s*([^*]+?)(?=\*\*SUMMARY:)/s);

      if (fileMatch && actionMatch) {
        const code = codeMatch ? codeMatch[1].trim() : '';
        const action = {
          file: fileMatch[1],
          lines: linesMatch ? linesMatch[1].trim() : 'unknown',
          timestamp: timestampMatch ? timestampMatch[1].trim() : new Date().toISOString(),
          code: code,
          codeHash: code ? hashCode(code) : undefined, // Calculate hash for validation
          action: actionMatch[1].trim()
        };

        // Add question/answer if this is question-linked
        if (questionMatch && answerMatch) {
          action.question = questionMatch[1].trim();
          action.answer = answerMatch[1].trim();
          action.questionIndex = undefined; // We don't have the original index
        }

        actions.push(action);
      }
    });

    return actions;
  }

  function showQuestionDialog() {
    // Check if we have a real selection (yellow highlight) or just a hover
    const hasRealSelection = GHAdapter.getSelectedLines().length > 0;

    // If no real selection, always capture the currently hovered row
    if (!hasRealSelection && currentHoveredRow) {
      captureHoveredRowAsSelection();
    } else if (!hasRealSelection && !currentHoveredRow) {
      alert('No code selected. Please select code lines or hover over a line.');
      return;
    }

    if (!currentSelection) {
      alert('No code selected. Please select code lines or hover over a line.');
      return;
    }

    const dialog = document.createElement('div');
    dialog.id = 'claude-question-dialog';
    dialog.className = 'claude-dialog';
    dialog.innerHTML = `
      <div class="claude-dialog-content">
        <h3>Ask Claude about this code</h3>
        <div class="selected-code">
          <strong>File:</strong> ${currentSelection.file}<br>
          <strong>Lines:</strong> ${currentSelection.lineNumbers}<br>
          <pre>${escapeHtml(currentSelection.text.substring(0, 200))}${currentSelection.text.length > 200 ? '...' : ''}</pre>
        </div>
        <textarea id="claude-question-input" placeholder="What would you like to ask Claude about this code?"></textarea>
        <div class="dialog-buttons">
          <button id="claude-save-question">Save Question</button>
          <button id="claude-cancel">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    document.getElementById('claude-save-question').addEventListener('click', saveQuestion);
    document.getElementById('claude-cancel').addEventListener('click', () => dialog.remove());
    document.getElementById('claude-question-input').focus();
  }

  function showEditActionDialog(actionEntry, actionIndex, questionEntry, questionIndex) {
    const isQuestionLinked = questionEntry !== null;

    const dialog = document.createElement('div');
    dialog.id = 'claude-action-dialog';
    dialog.className = 'claude-dialog';

    // Build dialog HTML
    let html = `
      <div class="claude-dialog-content">
        <h3>Edit Action</h3>
    `;

    // Show question/answer context if this is question-linked
    if (isQuestionLinked) {
      html += `
        <div class="selected-code" style="background: #f6f8fa; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
          <strong>File:</strong> ${actionEntry.file}<br>
          <strong>Lines:</strong> ${actionEntry.lines}<br>
          <strong>Q:</strong> ${escapeHtml(questionEntry.question)}<br>
          <strong>A:</strong> ${escapeHtml(questionEntry.answer.substring(0, 150))}${questionEntry.answer.length > 150 ? '...' : ''}
        </div>
      `;
    } else {
      // Show code for ad-hoc actions
      html += `
        <div class="selected-code">
          <strong>File:</strong> ${actionEntry.file}<br>
          <strong>Lines:</strong> ${actionEntry.lines}<br>
          <pre>${escapeHtml(actionEntry.code.substring(0, 200))}${actionEntry.code.length > 200 ? '...' : ''}</pre>
        </div>
      `;
    }

    html += `
        <textarea id="claude-action-input" placeholder="What should Claude do with this code?">${escapeHtml(actionEntry.action)}</textarea>
        <div class="dialog-buttons">
          <button id="claude-save-action">Save Changes</button>
          <button id="claude-cancel-action">Cancel</button>
        </div>
      </div>
    `;

    dialog.innerHTML = html;
    document.body.appendChild(dialog);

    // Event listeners
    document.getElementById('claude-save-action').addEventListener('click', () => {
      const newActionText = document.getElementById('claude-action-input').value.trim();
      if (!newActionText) {
        alert('Please enter an action for Claude to perform.');
        return;
      }
      updateAction(actionEntry, actionIndex, questionIndex, newActionText);
      dialog.remove();
    });

    document.getElementById('claude-cancel-action').addEventListener('click', () => {
      dialog.remove();
    });

    document.getElementById('claude-action-input').focus();
  }

  async function updateAction(actionEntry, actionIndex, questionIndex, newActionText) {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return;

    // Update the action in storage
    const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    const data = await chrome.storage.local.get(storageKey);
    const actions = data[storageKey] || [];

    if (actions[actionIndex]) {
      actions[actionIndex].action = newActionText;
      await chrome.storage.local.set({ [storageKey]: actions });

      // Update markdown file
      chrome.runtime.sendMessage({
        action: 'exportToActions',
        prInfo: currentPRInfo,
        actions: actions
      });

      // Update the DOM
      const isQuestionLinked = questionIndex !== null && questionIndex !== undefined;
      if (isQuestionLinked) {
        const existingQuestionId = `claude-entry-${questionIndex}`;
        const existingBox = document.getElementById(existingQuestionId);
        if (existingBox) {
          const actionText = existingBox.querySelector('.claude-action-text');
          if (actionText) {
            actionText.innerHTML = `<span class="action-label">Instructions:</span>${escapeHtml(newActionText)}`;
          }
        }
      } else {
        const existingId = `claude-action-${actionIndex}`;
        const actionBox = document.getElementById(existingId);
        if (actionBox) {
          const actionText = actionBox.querySelector('.claude-action-text');
          if (actionText) {
            actionText.innerHTML = `<span class="action-label">Instructions:</span>${escapeHtml(newActionText)}`;
          }
        }
      }

      showNotification('Action updated!');
    }
  }

  function showActionDialog(questionEntry, questionIndex) {
    // questionEntry and questionIndex will be null for ad-hoc actions
    const isQuestionLinked = questionEntry !== null;

    // For ad-hoc actions, we need a code selection
    if (!isQuestionLinked) {
      const hasRealSelection = GHAdapter.getSelectedLines().length > 0;

      if (!hasRealSelection && currentHoveredRow) {
        captureHoveredRowAsSelection();
      } else if (!hasRealSelection && !currentHoveredRow) {
        alert('No code selected. Please select code lines or hover over a line.');
        return;
      }

      if (!currentSelection) {
        alert('No code selected. Please select code lines or hover over a line.');
        return;
      }
    }

    const dialog = document.createElement('div');
    dialog.id = 'claude-action-dialog';
    dialog.className = 'claude-dialog';

    // Build dialog HTML
    let html = `
      <div class="claude-dialog-content">
        <h3>Tell Claude what to do</h3>
    `;

    // Show question/answer context if this is question-linked
    if (isQuestionLinked) {
      html += `
        <div class="selected-code" style="background: #f6f8fa; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
          <strong>File:</strong> ${questionEntry.file}<br>
          <strong>Lines:</strong> ${questionEntry.lines}<br>
          <strong>Q:</strong> ${escapeHtml(questionEntry.question)}<br>
          <strong>A:</strong> ${escapeHtml(questionEntry.answer.substring(0, 150))}${questionEntry.answer.length > 150 ? '...' : ''}
        </div>
      `;
    } else {
      // Show code selection for ad-hoc actions
      html += `
        <div class="selected-code">
          <strong>File:</strong> ${currentSelection.file}<br>
          <strong>Lines:</strong> ${currentSelection.lineNumbers}<br>
          <pre>${escapeHtml(currentSelection.text.substring(0, 200))}${currentSelection.text.length > 200 ? '...' : ''}</pre>
        </div>
      `;
    }

    html += `
        <textarea id="claude-action-input" placeholder="What should Claude do with this code?"></textarea>
        <div class="dialog-buttons">
          <button id="claude-save-action">Save Action</button>
          <button id="claude-cancel-action">Cancel</button>
        </div>
      </div>
    `;

    dialog.innerHTML = html;
    document.body.appendChild(dialog);

    // Event listeners
    document.getElementById('claude-save-action').addEventListener('click', () => {
      const actionText = document.getElementById('claude-action-input').value.trim();
      if (!actionText) {
        alert('Please enter an action for Claude to perform.');
        return;
      }
      saveAction(questionEntry, questionIndex, actionText);
    });

    document.getElementById('claude-cancel-action').addEventListener('click', () => {
      dialog.remove();
    });

    document.getElementById('claude-action-input').focus();
  }

  function captureHoveredRowAsSelection() {
    if (!currentHoveredRow) return;

    const codeCell = GHAdapter.getCodeCell(currentHoveredRow);
    if (!codeCell) return;

    const marker = GHAdapter.getCodeMarker(codeCell);
    const codeText = codeCell.textContent;

    const lineNumCell = GHAdapter.getRightLineNum(currentHoveredRow);
    const lineNum = lineNumCell?.getAttribute('data-line-number') || 'unknown';

    const file = getFileNameFromDiff(currentHoveredRow);

    currentSelection = {
      text: `${marker} ${codeText}`,
      file: file,
      lineNumbers: `L${lineNum}`
    };
  }

  async function saveQuestion() {
    const question = document.getElementById('claude-question-input').value.trim();
    if (!question) return;

    currentPRInfo = getPRInfo();
    if (!currentPRInfo) {
      alert('Could not detect PR information');
      return;
    }

    // Create markdown entry
    const entry = {
      timestamp: new Date().toISOString(),
      file: currentSelection.file,
      lines: currentSelection.lineNumbers,
      code: currentSelection.text,
      codeHash: hashCode(currentSelection.text), // Store hash for validation
      question: question
    };

    // Save to local storage
    const storageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    const existingData = await chrome.storage.local.get(storageKey);
    const questions = existingData[storageKey] || [];
    questions.push(entry);

    await chrome.storage.local.set({ [storageKey]: questions });

    // Also store PR metadata
    await chrome.storage.local.set({
      [`pr_meta_${storageKey}`]: {
        repo: currentPRInfo.fullRepoName,
        prTitle: currentPRInfo.prTitle,
        prNumber: currentPRInfo.prNumber,
        baseBranch: currentPRInfo.baseBranch,
        headBranch: currentPRInfo.headBranch
      }
    });

    document.getElementById('claude-question-dialog').remove();
    removeClaudeButton();

    // Show the question inline immediately
    displayQuestionInline(entry, questions.length - 1);

    // Request export to markdown file via background script
    chrome.runtime.sendMessage({
      action: 'exportToMarkdown',
      prInfo: currentPRInfo,
      questions: questions
    });
  }

  async function saveAction(questionEntry, questionIndex, actionText) {
    console.log('[SAVE-ACTION] Starting saveAction with:', { questionEntry, questionIndex, actionText });
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) {
      alert('Could not detect PR information');
      return;
    }

    const isQuestionLinked = questionEntry !== null;
    console.log('[SAVE-ACTION] isQuestionLinked:', isQuestionLinked);

    // Create action entry
    const code = isQuestionLinked ? questionEntry.code : currentSelection.text;
    const actionEntry = {
      timestamp: new Date().toISOString(),
      file: isQuestionLinked ? questionEntry.file : currentSelection.file,
      lines: isQuestionLinked ? questionEntry.lines : currentSelection.lineNumbers,
      code: code,
      codeHash: hashCode(code), // Store hash for validation
      action: actionText
    };

    // Add question/answer context if this is question-linked
    if (isQuestionLinked) {
      actionEntry.questionIndex = questionIndex;
      actionEntry.question = questionEntry.question;
      actionEntry.answer = questionEntry.answer;
    }

    // Save to local storage
    const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    const existingData = await chrome.storage.local.get(storageKey);
    const actions = existingData[storageKey] || [];
    actions.push(actionEntry);

    await chrome.storage.local.set({ [storageKey]: actions });

    // Also store PR metadata (same as questions)
    await chrome.storage.local.set({
      [`pr_meta_${storageKey}`]: {
        repo: currentPRInfo.fullRepoName,
        prTitle: currentPRInfo.prTitle,
        prNumber: currentPRInfo.prNumber,
        baseBranch: currentPRInfo.baseBranch,
        headBranch: currentPRInfo.headBranch
      }
    });

    document.getElementById('claude-action-dialog')?.remove();
    removeClaudeButton();

    console.log('[SAVE-ACTION] Calling displayActionInline with:', { actionEntry, actionIndex: actions.length - 1, questionIndex });
    // Display the action inline
    displayActionInline(actionEntry, actions.length - 1, questionIndex);

    console.log('[SAVE-ACTION] Action saved successfully');

    // Request export to actions file via background script
    chrome.runtime.sendMessage({
      action: 'exportToActions',
      prInfo: currentPRInfo,
      actions: actions
    });
  }

  function showNotification(message) {
    const notification = document.createElement('div');
    notification.className = 'claude-notification';
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // Expose globally for agent-client.js
  window.showNotification = showNotification;

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Auto-restore from markdown files on page load
  async function autoRestoreFromFiles() {
    try {
      currentPRInfo = getPRInfo();
      if (!currentPRInfo) return;

      const repoName = currentPRInfo.fullRepoName.split('/')[1];
      const prFolder = `PR-${currentPRInfo.prNumber}`;
      const dateStr = new Date().toISOString().split('T')[0];

      // Check Questions file
      const questionsFilename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;
      const questionsStorageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;

      console.log('[AUTO-RESTORE] Checking for Questions file:', questionsFilename);

      try {
        const response = await fetch('http://localhost:47382/readFile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: questionsFilename })
        });

        if (response.ok) {
          const result = await response.json();
          if (result.success && result.content) {
            console.log('[AUTO-RESTORE] Found Questions file, syncing with storage...');
            const parsedFromFile = parseQuestionsMarkdown(result.content);

            // Always update storage with latest from file (includes answers)
            await chrome.storage.local.set({ [questionsStorageKey]: parsedFromFile });

            // Store PR metadata
            await chrome.storage.local.set({
              [`pr_meta_${questionsStorageKey}`]: {
                repo: currentPRInfo.fullRepoName,
                prTitle: currentPRInfo.prTitle,
                prNumber: currentPRInfo.prNumber,
                baseBranch: currentPRInfo.baseBranch,
                headBranch: currentPRInfo.headBranch
              }
            });

            console.log(`[AUTO-RESTORE] Synced ${parsedFromFile.length} questions from file (including any answers)`);
          }
        } else {
          // File doesn't exist - clear storage to match
          console.log('[AUTO-RESTORE] Questions file not found, clearing storage');
          await chrome.storage.local.remove([questionsStorageKey, `pr_meta_${questionsStorageKey}`]);
        }
      } catch (err) {
        console.log('[AUTO-RESTORE] Questions file not found, clearing storage');
        await chrome.storage.local.remove([questionsStorageKey, `pr_meta_${questionsStorageKey}`]);
      }

      // Check Actions file
      const actionsFilename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;
      const actionsStorageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;

      console.log('[AUTO-RESTORE] Checking for Actions file:', actionsFilename);

      try {
        const response = await fetch('http://localhost:47382/readFile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: actionsFilename })
        });

        if (response.ok) {
          const result = await response.json();
          if (result.success && result.content) {
            console.log('[AUTO-RESTORE] Found Actions file, syncing with storage...');
            const parsedFromFile = parseActionsMarkdown(result.content);

            // Always update storage with latest from file (includes summaries)
            await chrome.storage.local.set({ [actionsStorageKey]: parsedFromFile });

            console.log(`[AUTO-RESTORE] Synced ${parsedFromFile.length} actions from file (including any summaries)`);
          }
        } else {
          // File doesn't exist - clear storage to match
          console.log('[AUTO-RESTORE] Actions file not found, clearing storage');
          await chrome.storage.local.remove(actionsStorageKey);
        }
      } catch (err) {
        console.log('[AUTO-RESTORE] Actions file not found, clearing storage');
        await chrome.storage.local.remove(actionsStorageKey);
      }
    } catch (error) {
      console.error('[AUTO-RESTORE] Error during auto-restore:', error);
    }
  }

  // Check if there are questions/actions (used by button handlers)
  async function hasQuestions() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return false;

    const questionsKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    const data = await chrome.storage.local.get(questionsKey);
    const questions = data[questionsKey] || [];
    return questions.length > 0;
  }

  async function hasUnansweredQuestions() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return false;

    const questionsKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    const data = await chrome.storage.local.get(questionsKey);
    const questions = data[questionsKey] || [];

    // Check if any questions are missing answers
    return questions.some(q => !q.answer || q.answer.trim().length === 0);
  }

  async function hasActions() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return false;

    const actionsKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    const data = await chrome.storage.local.get(actionsKey);
    const actions = data[actionsKey] || [];
    return actions.length > 0;
  }

  async function hasIncompleteActions() {
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) return false;

    const actionsKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
    const data = await chrome.storage.local.get(actionsKey);
    const actions = data[actionsKey] || [];

    // Check if any actions are missing summaries
    return actions.some(a => !a.summary || a.summary.trim().length === 0);
  }

  // Load and display existing questions and answers
  async function loadAndDisplayAnswers() {
    try {
      currentPRInfo = getPRInfo();
      if (!currentPRInfo) return;

      const storageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
      const data = await chrome.storage.local.get(storageKey);
      const questions = data[storageKey] || [];

      // Display ALL questions/answers inline in the PR view (both answered and unanswered)
      questions.forEach((entry, index) => {
        displayQuestionInline(entry, index);
      });
    } catch (error) {
      // Extension context invalidated - page needs refresh
      if (error.message.includes('Extension context invalidated')) {
        console.log('Extension was reloaded. Please refresh the page.');
      } else {
        console.error('Error loading answers:', error);
      }
    }
  }

  // Load and display existing actions
  async function loadAndDisplayActions() {
    try {
      currentPRInfo = getPRInfo();
      if (!currentPRInfo) return;

      const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
      const data = await chrome.storage.local.get(storageKey);
      const actions = data[storageKey] || [];

      // Display ALL actions inline in the PR view
      actions.forEach((entry, index) => {
        displayActionInline(entry, index, entry.questionIndex);
      });
    } catch (error) {
      console.error('Error loading actions:', error);
    }
  }

  function displayQuestionInline(entry, index) {
    // Find the specific line(s) of code this question is about
    const files = GHAdapter.getAllFiles();
    files.forEach(file => {
      const fileName = GHAdapter.getFileName(file);
      if (fileName === entry.file) {
        // Check if already displayed (prevent duplicates)
        const existingId = `claude-entry-${index}`;
        if (document.getElementById(existingId)) return;

        // Parse line numbers from entry.lines (e.g., "L29" or "L29-L35")
        const lineMatch = entry.lines.match(/L(\d+)(?:-L(\d+))?/);
        if (!lineMatch) return;

        const startLine = lineMatch[1];
        const endLine = lineMatch[2] || startLine;

        // Find the row for the end line (where we'll insert the comment)
        const targetRow = findRowByLineNumber(file, endLine);
        if (!targetRow) return;

        // Validate code if hash exists
        let validationStatus = null;
        let validationCurrentCode = null;
        if (entry.codeHash) {
          const validation = validateCode(entry);
          validationStatus = validation.status;
          validationCurrentCode = validation.currentCode;
        }

        // Create comment row (like GitHub PR comments)
        const commentRow = document.createElement('tr');
        commentRow.id = existingId;
        commentRow.className = 'claude-inline-comment-row';

        // Determine validation CSS class
        let validationClass = '';
        if (validationStatus === 'valid') {
          validationClass = 'claude-validation-valid';
        } else if (validationStatus === 'partial') {
          validationClass = 'claude-validation-partial';
        } else if (validationStatus === 'invalid' || validationStatus === 'missing' || validationStatus === 'file-not-found') {
          validationClass = 'claude-validation-invalid';
        }

        // Build HTML for the comment (spanning all columns)
        let html = `
          <td colspan="${(targetRow.children && targetRow.children.length) || 3}" class="claude-comment-cell">
            <div class="claude-inline-comment ${validationClass}">
              <div class="claude-comment-header">
                ${CLAUDE_ICON_SVG}
                <strong>Claude Review</strong>
                <span class="claude-comment-meta">${entry.file} (${entry.lines})</span>
                ${entry.answer ? '<button class="claude-action-btn" data-entry-id="' + existingId + '" data-question-index="' + index + '" title="Mark for action">Mark for Action</button><button class="claude-auto-action-btn" data-entry-id="' + existingId + '" data-question-index="' + index + '" title="Let Claude decide">I\'m feeling lucky</button>' : ''}
                ${(validationStatus === 'partial' || validationStatus === 'invalid') ? '<button class="claude-archive-btn" data-entry-id="' + existingId + '" data-question-index="' + index + '" title="Archive this question">Archive</button>' : ''}
                ${validationStatus ? '<button class="claude-view-original-btn" data-entry-id="' + existingId + '" data-original-code="' + escapeHtml(entry.code) + '" title="View code snapshot">View Code Snapshot</button>' : ''}
                <button class="claude-delete-btn" data-entry-id="${existingId}" title="Delete this question">×</button>
              </div>
              <div class="claude-comment-body">
                <div class="claude-question-text">
                  <strong>Q:</strong> ${escapeHtml(entry.question)}
                </div>
        `;

        // Add answer if it exists
        if (entry.answer) {
          html += `
                <div class="claude-answer-text">
                  <strong>A:</strong> ${formatMarkdown(entry.answer)}
                </div>
          `;
        } else {
          html += `
                <div class="claude-answer-text" style="font-style: italic; color: #656d76;">
                  <strong>A:</strong> <em>No answer yet. Click "Refresh Answers" after Claude fills in the markdown file.</em>
                </div>
          `;
        }

        html += `
              </div>
            </div>
          </td>
        `;

        commentRow.innerHTML = html;

        // Insert comment row right after the target row
        targetRow.after(commentRow);

        // Add "Mark for Action" button handler (only exists if answer is present)
        const actionBtn = commentRow.querySelector('.claude-action-btn');
        if (actionBtn) {
          actionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showActionDialog(entry, index);
          });
        }

        // Add "Do what Claude thinks is best" button handler
        const autoActionBtn = commentRow.querySelector('.claude-auto-action-btn');
        if (autoActionBtn) {
          console.log('[AUTO-ACTION] Button found, attaching listener');
          autoActionBtn.addEventListener('click', (e) => {
            console.log('[AUTO-ACTION] Button clicked!');
            e.preventDefault();
            e.stopPropagation();
            console.log('[AUTO-ACTION] Calling saveAction with:', entry, index);
            saveAction(entry, index, 'Apply the most appropriate solution for this section of code. Use idiomatic patterns and maintain consistency with the existing codebase style and conventions where possible. Refer to the repository\'s CLAUDE.md file for best practices if needed.');
          });
        } else {
          console.log('[AUTO-ACTION] Button NOT found in commentRow');
        }

        // Add "Archive" button handler (for partial/invalid validation)
        const archiveBtn = commentRow.querySelector('.claude-archive-btn');
        if (archiveBtn) {
          archiveBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!confirm('Archive this question? The markdown file will be archived and this question will be removed from the PR view.')) {
              return;
            }

            currentPRInfo = getPRInfo();
            if (!currentPRInfo) return;

            // Archive the questions file
            const repoName = currentPRInfo.fullRepoName.split('/')[1];
            const prFolder = `PR-${currentPRInfo.prNumber}`;
            const dateStr = new Date().toISOString().split('T')[0];
            const questionsFilename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;

            chrome.runtime.sendMessage({
              action: 'archiveFile',
              filename: questionsFilename
            });

            // Remove from storage
            const storageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
            const data = await chrome.storage.local.get(storageKey);
            const questions = data[storageKey] || [];

            questions.splice(index, 1);
            await chrome.storage.local.set({ [storageKey]: questions });

            // Update markdown file
            chrome.runtime.sendMessage({
              action: 'exportToMarkdown',
              prInfo: currentPRInfo,
              questions: questions
            });

            // Remove from DOM
            commentRow.remove();
            showNotification('Question archived');
          });
        }

        // Add "View Original" button handler
        const viewOriginalBtn = commentRow.querySelector('.claude-view-original-btn');
        if (viewOriginalBtn) {
          viewOriginalBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const originalCode = viewOriginalBtn.getAttribute('data-original-code');

            // Show modal with original code
            const modal = document.createElement('div');
            modal.className = 'claude-dialog';
            modal.innerHTML = `
              <div class="claude-dialog-content">
                <h3>Original Code Snapshot</h3>
                <div class="selected-code">
                  <strong>File:</strong> ${entry.file}<br>
                  <strong>Lines:</strong> ${entry.lines}<br>
                  <strong>Captured:</strong> ${new Date(entry.timestamp).toLocaleString()}<br>
                  <pre>${originalCode}</pre>
                </div>
                <div class="dialog-buttons">
                  <button id="claude-close-modal">Close</button>
                </div>
              </div>
            `;

            document.body.appendChild(modal);

            document.getElementById('claude-close-modal').addEventListener('click', () => {
              modal.remove();
            });

            // Close on background click
            modal.addEventListener('click', (e) => {
              if (e.target === modal) {
                modal.remove();
              }
            });
          });
        }

        // Add delete button handler
        const deleteBtn = commentRow.querySelector('.claude-delete-btn');
        deleteBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (!confirm('Delete this question? This will remove it from browser memory and the markdown file.')) {
            return;
          }

          // Remove from storage
          currentPRInfo = getPRInfo();
          if (!currentPRInfo) return;

          const storageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
          const data = await chrome.storage.local.get(storageKey);
          const questions = data[storageKey] || [];

          // Remove this entry
          questions.splice(index, 1);

          if (questions.length === 0) {
            // Last question deleted - remove storage and delete file
            await chrome.storage.local.remove([storageKey, `pr_meta_${storageKey}`]);

            // Delete the markdown file
            const repoName = currentPRInfo.fullRepoName.split('/')[1];
            const prFolder = `PR-${currentPRInfo.prNumber}`;
            const dateStr = new Date().toISOString().split('T')[0];
            const filename = `${repoName}/${prFolder}/Questions ${dateStr}.md`;

            try {
              await fetch('http://localhost:47382/deleteFile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
              });
            } catch (err) {
              console.error('Error deleting file:', err);
            }

            showNotification('Last question deleted - file removed');
          } else {
            // Update storage
            await chrome.storage.local.set({ [storageKey]: questions });

            // Update markdown file
            chrome.runtime.sendMessage({
              action: 'exportToMarkdown',
              prInfo: currentPRInfo,
              questions: questions
            });

            showNotification('Question deleted');
          }

          // Remove from DOM
          commentRow.remove();
        });
      }
    });
  }

  function displayActionInline(actionEntry, actionIndex, questionIndex) {
    console.log('[DISPLAY-ACTION] Starting displayActionInline with:', { actionEntry, actionIndex, questionIndex });
    const isQuestionLinked = questionIndex !== null && questionIndex !== undefined;
    console.log('[DISPLAY-ACTION] isQuestionLinked:', isQuestionLinked);

    if (isQuestionLinked) {
      console.log('[DISPLAY-ACTION] Question-linked action - converting existing box');
      // Find the existing question box and convert it to an action box
      const existingQuestionId = `claude-entry-${questionIndex}`;
      console.log('[DISPLAY-ACTION] Looking for existing box with ID:', existingQuestionId);
      const existingBox = document.getElementById(existingQuestionId);
      console.log('[DISPLAY-ACTION] Existing box found:', !!existingBox);

      if (existingBox) {
        console.log('[DISPLAY-ACTION] Converting question box to action box');
        // Add pink styling
        const commentDiv = existingBox.querySelector('.claude-inline-comment');
        if (commentDiv) {
          commentDiv.classList.add('claude-action-box');
        }

        // Update header to match action box style
        const header = existingBox.querySelector('.claude-comment-header');
        if (header) {
          header.innerHTML = `
            ${CLAUDE_ICON_SVG}
            <strong>Claude to Action</strong>
            <span class="claude-comment-meta">${actionEntry.file} (${actionEntry.lines})</span>
            <button class="claude-edit-action-btn" data-action-index="${actionIndex}" data-question-index="${questionIndex}" title="Edit action">Edit</button>
            <button class="claude-delete-action-btn" data-action-index="${actionIndex}" title="Delete this action">×</button>
          `;
        }

        // Add action section below answer
        const commentBody = existingBox.querySelector('.claude-comment-body');
        if (commentBody) {
          // Remove existing action section if present
          const existingAction = commentBody.querySelector('.claude-action-section');
          if (existingAction) {
            existingAction.remove();
          }

          // Add action section
          const actionSection = document.createElement('div');
          actionSection.className = 'claude-action-section';
          actionSection.innerHTML = `
            <div class="claude-action-text">
              <span class="action-label">Instructions:</span>${escapeHtml(actionEntry.action)}
            </div>
          `;
          commentBody.appendChild(actionSection);
        }

        // Add edit handler for action
        const editBtn = existingBox.querySelector('.claude-edit-action-btn');
        if (editBtn) {
          editBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Get current action entry from storage
            currentPRInfo = getPRInfo();
            if (!currentPRInfo) return;

            const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
            chrome.storage.local.get(storageKey).then(data => {
              const actions = data[storageKey] || [];
              const currentAction = actions[actionIndex];
              if (currentAction) {
                // Find the question entry if this is question-linked
                const questionStorageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
                chrome.storage.local.get(questionStorageKey).then(qData => {
                  const questions = qData[questionStorageKey] || [];
                  const questionEntry = questionIndex !== null && questionIndex !== undefined ? questions[questionIndex] : null;
                  showEditActionDialog(currentAction, actionIndex, questionEntry, questionIndex);
                });
              }
            });
          });
        }

        // Add delete handler for action
        const deleteBtn = existingBox.querySelector('.claude-delete-action-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!confirm('Delete this action? This will remove it from browser memory and the actions file.')) {
              return;
            }

            currentPRInfo = getPRInfo();
            if (!currentPRInfo) return;

            const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
            const data = await chrome.storage.local.get(storageKey);
            const actions = data[storageKey] || [];

            actions.splice(actionIndex, 1);
            await chrome.storage.local.set({ [storageKey]: actions });

            chrome.runtime.sendMessage({
              action: 'exportToActions',
              prInfo: currentPRInfo,
              actions: actions
            });

            // Revert to question box (remove action styling and section)
            if (commentDiv) {
              commentDiv.classList.remove('claude-action-box');
            }
            const actionSection = commentBody.querySelector('.claude-action-section');
            if (actionSection) {
              actionSection.remove();
            }

            // Restore original question header (need to get question entry first)
            if (header) {
              const questionStorageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
              const qData = await chrome.storage.local.get(questionStorageKey);
              const questions = qData[questionStorageKey] || [];
              const questionEntry = questions[questionIndex];

              header.innerHTML = `
                ${CLAUDE_ICON_SVG}
                <strong>Claude Review</strong>
                <span class="claude-comment-meta">${actionEntry.file} (${actionEntry.lines})</span>
                ${questionEntry && questionEntry.answer ? '<button class="claude-action-btn" data-entry-id="' + existingQuestionId + '" data-question-index="' + questionIndex + '" title="Mark for action">Mark for Action</button><button class="claude-auto-action-btn" data-entry-id="' + existingQuestionId + '" data-question-index="' + questionIndex + '" title="Let Claude decide">I\'m feeling lucky</button>' : ''}
                <button class="claude-delete-btn" data-entry-id="${existingQuestionId}" title="Delete this question">×</button>
              `;

              // Re-attach event listeners for the restored buttons
              const actionBtn = header.querySelector('.claude-action-btn');
              if (actionBtn) {
                actionBtn.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  showActionDialog(questionEntry, questionIndex);
                });
              }

              const autoActionBtn = header.querySelector('.claude-auto-action-btn');
              if (autoActionBtn) {
                console.log('[AUTO-ACTION] Restored button found, re-attaching listener');
                autoActionBtn.addEventListener('click', (e) => {
                  console.log('[AUTO-ACTION] Restored button clicked!');
                  e.preventDefault();
                  e.stopPropagation();
                  console.log('[AUTO-ACTION] Calling saveAction with:', questionEntry, questionIndex);
                  saveAction(questionEntry, questionIndex, 'Apply the most appropriate solution for this section of code. Use idiomatic patterns and maintain consistency with the existing codebase style and conventions where possible. Refer to the repository\'s CLAUDE.md file for best practices if needed.');
                });
              }

              const deleteBtn = header.querySelector('.claude-delete-btn');
              if (deleteBtn) {
                deleteBtn.addEventListener('click', async (e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  if (!confirm('Delete this question? This will remove it from browser memory and the markdown file.')) {
                    return;
                  }

                  const storageKey = `pr_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
                  const data = await chrome.storage.local.get(storageKey);
                  const questions = data[storageKey] || [];

                  questions.splice(questionIndex, 1);
                  await chrome.storage.local.set({ [storageKey]: questions });

                  chrome.runtime.sendMessage({
                    action: 'exportToMarkdown',
                    prInfo: currentPRInfo,
                    questions: questions
                  });

                  existingBox.remove();
                  showNotification('Question deleted');
                });
              }
            }

            showNotification('Action deleted');
          });
        }
      }
    } else {
      // Create new ad-hoc action box (pink, no question/answer)
      const files = GHAdapter.getAllFiles();
      files.forEach(file => {
        const fileName = GHAdapter.getFileName(file);
        if (fileName === actionEntry.file) {
          const existingId = `claude-action-${actionIndex}`;
          if (document.getElementById(existingId)) return;

          // Parse line numbers
          const lineMatch = actionEntry.lines.match(/L(\d+)(?:-L(\d+))?/);
          if (!lineMatch) return;

          const startLine = lineMatch[1];
          const endLine = lineMatch[2] || startLine;

          const targetRow = findRowByLineNumber(file, endLine);
          if (!targetRow) return;

          // Validate code if hash exists
          let validationStatus = null;
          let validationCurrentCode = null;
          if (actionEntry.codeHash) {
            const validation = validateCode(actionEntry);
            validationStatus = validation.status;
            validationCurrentCode = validation.currentCode;
          }

          // Create action row
          const actionRow = document.createElement('tr');
          actionRow.id = existingId;
          actionRow.className = 'claude-inline-comment-row';

          // Determine validation CSS class
          let validationClass = '';
          if (validationStatus === 'valid') {
            validationClass = 'claude-validation-valid';
          } else if (validationStatus === 'partial') {
            validationClass = 'claude-validation-partial';
          } else if (validationStatus === 'invalid' || validationStatus === 'missing' || validationStatus === 'file-not-found') {
            validationClass = 'claude-validation-invalid';
          }

          const html = `
            <td colspan="${(targetRow.children && targetRow.children.length) || 3}" class="claude-comment-cell">
              <div class="claude-inline-comment claude-action-box ${validationClass}">
                <div class="claude-comment-header">
                  ${CLAUDE_ICON_SVG}
                  <strong>Claude to Action</strong>
                  <span class="claude-comment-meta">${actionEntry.file} (${actionEntry.lines})</span>
                  <button class="claude-edit-action-btn" data-action-index="${actionIndex}" title="Edit action">Edit</button>
                  ${(validationStatus === 'partial' || validationStatus === 'invalid') ? '<button class="claude-archive-action-btn" data-action-index="' + actionIndex + '" title="Archive this action">Archive</button>' : ''}
                  ${validationStatus ? '<button class="claude-view-original-action-btn" data-action-index="' + actionIndex + '" data-original-code="' + escapeHtml(actionEntry.code) + '" title="View code snapshot">View Code Snapshot</button>' : ''}
                  <button class="claude-delete-action-btn" data-action-index="${actionIndex}" title="Delete this action">×</button>
                </div>
                <div class="claude-comment-body">
                  <div class="claude-action-text">
                    <span class="action-label">Instructions:</span>${escapeHtml(actionEntry.action)}
                  </div>
                </div>
              </div>
            </td>
          `;

          actionRow.innerHTML = html;
          targetRow.after(actionRow);

          // Add edit handler for ad-hoc action
          const editBtn = actionRow.querySelector('.claude-edit-action-btn');
          editBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            currentPRInfo = getPRInfo();
            if (!currentPRInfo) return;

            const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
            chrome.storage.local.get(storageKey).then(data => {
              const actions = data[storageKey] || [];
              const currentAction = actions[actionIndex];
              if (currentAction) {
                showEditActionDialog(currentAction, actionIndex, null, null);
              }
            });
          });

          // Add "Archive" button handler (for partial/invalid validation)
          const archiveActionBtn = actionRow.querySelector('.claude-archive-action-btn');
          if (archiveActionBtn) {
            archiveActionBtn.addEventListener('click', async (e) => {
              e.preventDefault();
              e.stopPropagation();

              if (!confirm('Archive this action? The actions file will be archived and this action will be removed from the PR view.')) {
                return;
              }

              currentPRInfo = getPRInfo();
              if (!currentPRInfo) return;

              // Archive the actions file
              const repoName = currentPRInfo.fullRepoName.split('/')[1];
              const prFolder = `PR-${currentPRInfo.prNumber}`;
              const dateStr = new Date().toISOString().split('T')[0];
              const actionsFilename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;

              chrome.runtime.sendMessage({
                action: 'archiveFile',
                filename: actionsFilename
              });

              // Remove from storage
              const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
              const data = await chrome.storage.local.get(storageKey);
              const actions = data[storageKey] || [];

              actions.splice(actionIndex, 1);
              await chrome.storage.local.set({ [storageKey]: actions });

              // Update markdown file
              chrome.runtime.sendMessage({
                action: 'exportToActions',
                prInfo: currentPRInfo,
                actions: actions
              });

              // Remove from DOM
              actionRow.remove();
              showNotification('Action archived');
            });
          }

          // Add "View Original" button handler
          const viewOriginalActionBtn = actionRow.querySelector('.claude-view-original-action-btn');
          if (viewOriginalActionBtn) {
            viewOriginalActionBtn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();

              const originalCode = viewOriginalActionBtn.getAttribute('data-original-code');

              // Show modal with original code
              const modal = document.createElement('div');
              modal.className = 'claude-dialog';
              modal.innerHTML = `
                <div class="claude-dialog-content">
                  <h3>Original Code Snapshot</h3>
                  <div class="selected-code">
                    <strong>File:</strong> ${actionEntry.file}<br>
                    <strong>Lines:</strong> ${actionEntry.lines}<br>
                    <strong>Captured:</strong> ${new Date(actionEntry.timestamp).toLocaleString()}<br>
                    <pre>${originalCode}</pre>
                  </div>
                  <div class="dialog-buttons">
                    <button id="claude-close-modal">Close</button>
                  </div>
                </div>
              `;

              document.body.appendChild(modal);

              document.getElementById('claude-close-modal').addEventListener('click', () => {
                modal.remove();
              });

              // Close on background click
              modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                  modal.remove();
                }
              });
            });
          }

          // Add delete handler
          const deleteBtn = actionRow.querySelector('.claude-delete-action-btn');
          deleteBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!confirm('Delete this action? This will remove it from browser memory and the actions file.')) {
              return;
            }

            currentPRInfo = getPRInfo();
            if (!currentPRInfo) return;

            const storageKey = `actions_${currentPRInfo.fullRepoName}_${currentPRInfo.prNumber}`;
            const data = await chrome.storage.local.get(storageKey);
            const actions = data[storageKey] || [];

            actions.splice(actionIndex, 1);

            if (actions.length === 0) {
              // Last action deleted - remove storage and delete file
              await chrome.storage.local.remove(storageKey);

              // Delete the markdown file
              const repoName = currentPRInfo.fullRepoName.split('/')[1];
              const prFolder = `PR-${currentPRInfo.prNumber}`;
              const dateStr = new Date().toISOString().split('T')[0];
              const filename = `${repoName}/${prFolder}/Actions ${dateStr}.md`;

              try {
                await fetch('http://localhost:47382/deleteFile', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ filename })
                });
              } catch (err) {
                console.error('Error deleting file:', err);
              }

              showNotification('Last action deleted - file removed');
            } else {
              // Update storage
              await chrome.storage.local.set({ [storageKey]: actions });

              // Update markdown file
              chrome.runtime.sendMessage({
                action: 'exportToActions',
                prInfo: currentPRInfo,
                actions: actions
              });

              showNotification('Action deleted');
            }

            actionRow.remove();
          });
        }
      });
    }
  }

  // Find a diff row by line number, in either legacy or new-view DOM.
  function findRowByLineNumber(file, lineNumber) {
    const cell = GHAdapter.getLineCell(file, lineNumber);
    return cell ? GHAdapter.getLineRow(cell) : null;
  }

  function formatMarkdown(text) {
    // Enhanced markdown formatting with support for code blocks, lists, and more
    let html = escapeHtml(text);

    // Code blocks (```language ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });

    // Inline code (must come after code blocks)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Headings (### heading)
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Unordered lists
    html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Line breaks (must come last) - single line breaks become spaces, double become single <br>
    html = html.replace(/\n\n/g, '<br>');
    html = html.replace(/\n/g, ' ');

    return html;
  }

  // Add action buttons at top of PR (next to "Review changes")
  function addActionButtons() {
    // Check if already added
    if (document.getElementById('claude-action-buttons')) return;

    // Legacy: anchor next to the "Review changes" button.
    const reviewButton = document.querySelector('button[name="review[event]"], .js-reviews-toggle');
    let buttonContainer = reviewButton
      ? reviewButton.closest('.diffbar-item, .gh-header-actions, .gh-header-show')
      : null;
    let anchorAfter = reviewButton;

    // New experience: no legacy review button. Drop the controls into the diff
    // toolbar (the file-tree toggle row) or the PR top-bar actions instead.
    if (!buttonContainer) {
      // New experience: sit next to the "Submit comments" review button.
      const reviewMenuBtn = document.querySelector('[class*="ReviewMenuButton-module__ReviewMenuButton"]');
      if (reviewMenuBtn) {
        buttonContainer = reviewMenuBtn.parentElement;
        anchorAfter = reviewMenuBtn;
      } else {
        buttonContainer =
          document.querySelector('[data-testid="file-controls-divider"]')?.parentElement ||
          document.querySelector('[data-testid="expand-file-tree-button"]')?.parentElement ||
          document.querySelector('[data-testid="collapse-file-tree-button"]')?.parentElement ||
          document.querySelector('[data-testid="top-bar-actions"]');
        anchorAfter = null;
      }
    }

    if (!buttonContainer) {
      console.log('[CLAUDE] Toolbar not found yet, retrying...');
      setTimeout(addActionButtons, 800);
      return;
    }

    // Create button group
    const claudeButtons = document.createElement('div');
    claudeButtons.id = 'claude-action-buttons';
    claudeButtons.style.cssText = 'display: inline-flex; gap: 8px; margin-left: 8px;';

    // Answer Questions button (light orange)
    const answerBtn = document.createElement('button');
    answerBtn.className = 'btn btn-sm';
    answerBtn.id = 'claude-answer-questions-btn';
    answerBtn.innerHTML = 'Answer Questions';
    answerBtn.style.cssText = 'height: 28px; background: #fb8500; color: white; border: 1px solid #fb8500; font-weight: 500; padding: 0 12px;';
    answerBtn.title = 'Ask Claude to answer all unanswered questions';

    // Complete Actions button (light pink)
    const actionsBtn = document.createElement('button');
    actionsBtn.className = 'btn btn-sm';
    actionsBtn.id = 'claude-complete-actions-btn';
    actionsBtn.innerHTML = 'Start Actions';
    actionsBtn.style.cssText = 'height: 28px; background: #ffb3ba; color: #d6336c; border: 1px solid #ffb3ba; font-weight: 500; padding: 0 12px;';
    actionsBtn.title = 'Ask Claude to complete all pending actions';

    // Copy Action Prompt button (light pink, same style)
    const copyPromptBtn = document.createElement('button');
    copyPromptBtn.className = 'btn btn-sm';
    copyPromptBtn.id = 'claude-copy-action-prompt-btn';
    copyPromptBtn.innerHTML = 'Copy Action Prompt';
    copyPromptBtn.style.cssText = 'height: 28px; width: 140px; background: #ffb3ba; color: #d6336c; border: 1px solid #ffb3ba; font-weight: 500; padding: 0 4px;';
    copyPromptBtn.title = 'Copy action prompt for local Claude Code terminal (recommended for complex actions)';

    // Ultrathink checkbox
    const ultrathinkContainer = document.createElement('div');
    ultrathinkContainer.className = 'ultrathink-container';

    const ultrathinkCheckbox = document.createElement('input');
    ultrathinkCheckbox.type = 'checkbox';
    ultrathinkCheckbox.id = 'claude-ultrathink-checkbox';

    const ultrathinkLabel = document.createElement('label');
    ultrathinkLabel.htmlFor = 'claude-ultrathink-checkbox';
    ultrathinkLabel.innerHTML = `<span class="rainbow-text"><span class="letter-u">U</span><span class="letter-l">l</span><span class="letter-t">t</span><span class="letter-r">r</span><span class="letter-a">a</span><span class="letter-t2">t</span><span class="letter-h">h</span><span class="letter-i">i</span><span class="letter-n">n</span><span class="letter-k">k</span></span>`;

    ultrathinkContainer.appendChild(ultrathinkCheckbox);
    ultrathinkContainer.appendChild(ultrathinkLabel);

    // Add click handlers
    answerBtn.addEventListener('click', triggerAnswerQuestions);
    actionsBtn.addEventListener('click', triggerCompleteActions);
    copyPromptBtn.addEventListener('click', triggerCopyActionPrompt);

    // Add hover effects
    const addHoverEffect = (btn, hoverBg, normalBg) => {
      btn.addEventListener('mouseenter', () => btn.style.background = hoverBg);
      btn.addEventListener('mouseleave', () => btn.style.background = normalBg);
    };

    addHoverEffect(answerBtn, '#e67700', '#fb8500');
    addHoverEffect(actionsBtn, '#ffa0a7', '#ffb3ba');
    addHoverEffect(copyPromptBtn, '#ffa0a7', '#ffb3ba');

    claudeButtons.appendChild(answerBtn);
    claudeButtons.appendChild(actionsBtn);
    claudeButtons.appendChild(copyPromptBtn);
    claudeButtons.appendChild(ultrathinkContainer);

    // Insert next to the review button (legacy) or into the toolbar (new).
    if (anchorAfter && anchorAfter.parentElement === buttonContainer) {
      buttonContainer.insertBefore(claudeButtons, anchorAfter.nextSibling);
    } else {
      buttonContainer.appendChild(claudeButtons);
    }
    console.log('[CLAUDE] Action buttons added');
  }

  // Fetch the server's config once and cache it. Holds runMode + skipPermissions.
  let _serverConfigCache = null;
  async function getServerConfig() {
    if (_serverConfigCache) return _serverConfigCache;
    try {
      const r = await fetch('http://localhost:47382/getConfig');
      const j = await r.json();
      const cfg = j?.config || {};
      let m = cfg.runMode || 'interactive';
      if (m === 'subscription') m = 'interactive';
      _serverConfigCache = { runMode: m, skipPermissions: cfg.skipPermissions === true };
    } catch {
      _serverConfigCache = { runMode: 'interactive', skipPermissions: false };
    }
    return _serverConfigCache;
  }

  // "native Claude setup" run mode: 'interactive' | 'print' | 'sdk' | 'vertex'.
  async function getRunMode() {
    return (await getServerConfig()).runMode;
  }

  // Let the settings dialog clear the cache after a save so changes to run mode
  // / skip-permissions take effect immediately (no page reload needed).
  window.invalidateClaudeServerConfig = () => { _serverConfigCache = null; };

  // True for the two modes that open a Claude terminal window on the user's PC
  // (rather than the headless SDK + in-browser panel).
  function isWindowMode(mode) {
    return mode === 'interactive' || mode === 'print';
  }

  // Confirmation shown before opening a Claude window. Wording adapts to the
  // mode. When `skipAlreadyOn` is false, also offers a one-off checkbox to let
  // Claude act autonomously (--dangerously-skip-permissions) for this session.
  // Resolves to { choice: 'proceed'|'cancel'|'settings', skipOnce: boolean }.
  function showInteractiveConfirmDialog(mode, skipAlreadyOn) {
    const isPrint = mode === 'print';
    const heading = isPrint ? 'Run claude -p in a terminal?' : 'Open a live Claude session?';
    const body = isPrint
      ? `This will run <code>claude -p</code> in a terminal window on this PC and close it when done. Per Anthropic's billing, <code>-p</code> usage is <strong>billed at API rates</strong> from your Agent-SDK credit — not your interactive subscription.`
      : `This will open a live, interactive <code>claude</code> window on this PC that you can watch and steer. Anthropic treats this as <strong>normal subscription usage</strong>.`;

    // Autonomy block: only shown when the persistent setting is OFF. If it's
    // already on, we don't nag — Claude will run autonomously regardless.
    const autonomyBlock = skipAlreadyOn ? '' : `
      <label style="display:flex; align-items:flex-start; gap:8px; padding:10px 12px; background:#fff8f0; border:1px solid #ffd8a8; border-radius:6px; margin-bottom:16px; cursor:pointer;">
        <input type="checkbox" id="claude-skip-once" checked style="margin-top:2px; width:16px; height:16px; flex-shrink:0;">
        <span style="font-size:13px; line-height:1.5; color:#24292f;">
          Let Claude work autonomously this session (<code>--dangerously-skip-permissions</code>).
          This is usually needed for it to answer/act hands-off. <strong>If unchecked, Claude will pause and wait for your input</strong> in its terminal window. Enable it permanently under Settings.
        </span>
      </label>`;

    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.className = 'claude-dialog';
      dialog.innerHTML = `
        <div class="claude-dialog-content" style="max-width: 520px;">
          <h3>${heading}</h3>
          <p style="color:#24292f; font-size:14px; line-height:1.5; margin-bottom:12px;">${body}</p>
          ${autonomyBlock}
          <p style="color:#656d76; font-size:13px; line-height:1.5; margin-bottom:16px;">
            <a href="https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan" target="_blank" rel="noopener" style="color:#0969da;">How subscription &amp; Agent-SDK billing works →</a>
          </p>
          <div class="dialog-buttons">
            <button id="claude-interactive-proceed">Yes, continue</button>
            <button id="claude-interactive-settings">Go to settings</button>
            <button id="claude-interactive-cancel">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const done = (choice) => {
        const skipOnce = skipAlreadyOn ? true : (dialog.querySelector('#claude-skip-once')?.checked || false);
        dialog.remove();
        resolve({ choice, skipOnce });
      };
      dialog.querySelector('#claude-interactive-proceed').addEventListener('click', () => done('proceed'));
      dialog.querySelector('#claude-interactive-settings').addEventListener('click', () => done('settings'));
      dialog.querySelector('#claude-interactive-cancel').addEventListener('click', () => done('cancel'));
      dialog.addEventListener('click', (e) => { if (e.target === dialog) done('cancel'); });
    });
  }

  // Shown when the repo isn't found on disk. Lets the user point at an existing
  // clone or say it's not installed (→ Claude clones it). Resolves to
  // { choice:'have-path'|'not-installed'|'cancel', repoPath, remember }.
  function showRepoLocationDialog(info) {
    const repo = currentPRInfo?.fullRepoName || 'this repo';
    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.className = 'claude-dialog';
      dialog.innerHTML = `
        <div class="claude-dialog-content" style="max-width: 540px;">
          <h3>Where is <code>${escapeHtml(repo)}</code>?</h3>
          <p style="color:#24292f; font-size:14px; line-height:1.5; margin-bottom:12px;">
            I couldn't find this repository on your machine. It's not in your projects directory
            (<code>${escapeHtml(info.projectsDir || '')}</code>).
          </p>
          <label style="display:block; font-size:13px; font-weight:500; color:#24292f; margin-bottom:6px;">
            If it's already cloned somewhere, paste the full path:
          </label>
          <input type="text" id="claude-repo-path" placeholder="${escapeHtml(info.defaultPath || 'C:\\\\path\\\\to\\\\repo')}"
            style="width:100%; padding:8px; border:1px solid #d0d7de; border-radius:6px; font-family:monospace; font-size:12px; margin-bottom:8px;">
          <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#656d76; margin-bottom:16px; cursor:pointer;">
            <input type="checkbox" id="claude-repo-remember" checked style="width:15px; height:15px;">
            Remember this location for ${escapeHtml(repo)}
          </label>
          <div class="dialog-buttons">
            <button id="claude-repo-have">Use this path</button>
            <button id="claude-repo-clone">It's not installed - clone it</button>
            <button id="claude-repo-cancel">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const pathInput = dialog.querySelector('#claude-repo-path');
      pathInput.addEventListener('paste', (e) => {
        e.preventDefault();
        const t = (e.clipboardData || window.clipboardData).getData('text');
        pathInput.value = t.trim().replace(/^['"]|['"]$/g, '');
      });
      const done = (choice) => {
        const repoPath = pathInput.value.trim();
        const remember = dialog.querySelector('#claude-repo-remember')?.checked || false;
        dialog.remove();
        resolve({ choice, repoPath, remember });
      };
      dialog.querySelector('#claude-repo-have').addEventListener('click', () => {
        if (!pathInput.value.trim()) { pathInput.style.borderColor = '#d73a49'; return; }
        done('have-path');
      });
      dialog.querySelector('#claude-repo-clone').addEventListener('click', () => done('not-installed'));
      dialog.querySelector('#claude-repo-cancel').addEventListener('click', () => done('cancel'));
      dialog.addEventListener('click', (e) => { if (e.target === dialog) done('cancel'); });
    });
  }

  // Subscription-mode flow: confirm → resolve repo location → launch visible
  // claude window → poll the tracking file until complete → refresh inline
  // comments. Shared by the Questions and Actions buttons.
  async function runInteractiveFlow(kind) {
    // Guard against concurrent runs: a second window racing on the same repo
    // would cause competing git operations and fighting button states.
    if (window._claudeInteractiveBusy) {
      alert('A Claude run is already in progress. Wait for it to finish (or close its window) before starting another.');
      return;
    }
    const cfg = await getServerConfig();
    const mode = cfg.runMode;
    const skipAlreadyOn = cfg.skipPermissions;
    const { choice, skipOnce } = await showInteractiveConfirmDialog(mode, skipAlreadyOn);
    if (choice === 'cancel') return;
    if (choice === 'settings') { showSettingsDialog(); return; }

    currentPRInfo = getPRInfo();
    if (!currentPRInfo) { alert('Could not detect PR information'); return; }

    // Resolve where the repo lives. If the server can't find it on disk, ask.
    let repoOpts = {};
    try {
      const check = await window.agentClient.checkRepo(currentPRInfo.fullRepoName);
      if (!check.exists) {
        const loc = await showRepoLocationDialog(check);
        if (loc.choice === 'cancel') return;
        if (loc.choice === 'have-path') {
          repoOpts = { repoPath: loc.repoPath, rememberPath: loc.remember };
        } else if (loc.choice === 'not-installed') {
          repoOpts = { notInstalled: true };
        }
      }
    } catch (e) {
      console.warn('[INTERACTIVE] checkRepo failed, letting server auto-resolve:', e.message);
    }

    // If the persistent setting is on, let the server use it (send undefined).
    // Otherwise send the one-off checkbox value chosen in the dialog.
    const skipPermissions = skipAlreadyOn ? undefined : skipOnce;

    const isQuestions = kind === 'questions';
    const btn = document.getElementById(isQuestions ? 'claude-answer-questions-btn' : 'claude-complete-actions-btn');
    const idleLabel = isQuestions ? 'Answer Questions' : 'Start Actions';
    const ultrathinkCheckbox = document.getElementById('claude-ultrathink-checkbox');
    const useUltrathink = ultrathinkCheckbox?.checked || false;

    if (btn) { btn.disabled = true; btn.innerHTML = 'Opening Claude…'; }
    window._claudeInteractiveBusy = true;
    const finish = () => { window._claudeInteractiveBusy = false; if (btn) { btn.disabled = false; btn.innerHTML = idleLabel; } };

    try {
      const result = await window.agentClient.runInteractive(currentPRInfo, kind, useUltrathink, skipPermissions, repoOpts);
      if (!result.success) throw new Error(result.error || 'Failed to launch Claude');

      showNotification('🖥️ Claude window opened — it will edit the file and close when done.');
      if (btn) btn.innerHTML = 'Claude is working…';

      // Poll the tracking file for completion (up to 15 min).
      const verify = isQuestions ? verifyAllQuestionsAnswered : verifyAllActionsCompleted;
      const refresh = isQuestions ? refreshAnswersFromFile : refreshQuestionsAndActions;
      const deadline = Date.now() + 15 * 60 * 1000;

      const poll = async () => {
        if (Date.now() > deadline) {
          showNotification('⌛ Timed out waiting for Claude. Use "Refresh Questions/Actions" when it finishes.');
          finish();
          return;
        }
        let done = false;
        try { done = await verify(); } catch {}
        if (done) {
          try { await refresh(); } catch {}
          showNotification(`✅ ${isQuestions ? 'Answers' : 'Actions'} updated from Claude.`);
          finish();
        } else {
          setTimeout(poll, 4000);
        }
      };
      setTimeout(poll, 5000);
    } catch (error) {
      console.error('[INTERACTIVE] Error:', error);
      alert('Failed to open Claude session: ' + error.message);
      finish();
    }
  }

  async function triggerAnswerQuestions() {
    const btn = document.getElementById('claude-answer-questions-btn');
    const currentState = btn.getAttribute('data-state') || 'idle';

    // Window modes (live subscription window / claude -p) → open a Claude
    // terminal instead of the headless SDK + in-browser panel.
    if (isWindowMode(await getRunMode()) && currentState !== 'running') {
      if (!(await hasQuestions())) {
        alert('No questions to answer. Please select code and add questions first.');
        return;
      }
      if (!(await hasUnansweredQuestions())) {
        alert('All questions have already been answered. Add new questions if you need more answers.');
        return;
      }
      await runInteractiveFlow('questions');
      return;
    }

    // Handle different button states
    if (currentState === 'running') {
      // User wants to view progress - reopen monitor panel
      if (window.agentMonitorPanel) {
        window.agentMonitorPanel.open();
      }
      return;
    }

    // Check if there are any questions
    if (!(await hasQuestions())) {
      alert('No questions to answer. Please select code and add questions first.');
      return;
    }

    // Check if all questions are already answered
    if (!(await hasUnansweredQuestions())) {
      alert('All questions have already been answered. Add new questions if you need more answers.');
      return;
    }

    // Start new session
    btn.disabled = true;
    btn.innerHTML = 'Starting...';
    btn.setAttribute('data-state', 'starting');

    // Open monitor panel
    if (window.agentMonitorPanel) {
      window.agentMonitorPanel.open();
      window.agentMonitorPanel.clearLogs();
      window.agentMonitorPanel.addLog('Starting Claude agent session...', 'info');
    }

    try {
      currentPRInfo = getPRInfo();
      if (!currentPRInfo) {
        throw new Error('Could not detect PR information');
      }

      // Start agent session and connect WebSocket
      await window.agentClient.startSession();

      btn.innerHTML = 'View Progress';
      btn.setAttribute('data-state', 'running');
      btn.disabled = false;

      if (window.agentMonitorPanel) {
        window.agentMonitorPanel.addLog('Connected to agent server', 'success');
      }

      // Start heartbeat monitoring
      window.agentClient.startHeartbeatMonitoring();

      // Check ultrathink checkbox state
      const ultrathinkCheckbox = document.getElementById('claude-ultrathink-checkbox');
      const useUltrathink = ultrathinkCheckbox?.checked || false;

      // Answer questions using Agent SDK
      const result = await window.agentClient.answerQuestions(currentPRInfo, useUltrathink);

      if (result.success) {
        // Verify all questions have been answered
        const allAnswered = await verifyAllQuestionsAnswered();

        if (allAnswered) {
          if (window.agentMonitorPanel) {
            window.agentMonitorPanel.addLog('All questions answered successfully!', 'success');
            window.agentMonitorPanel.addLog('Refreshing answers...', 'info');
          }

          // Auto-refresh answers from file
          await refreshAnswersFromFile();

          if (window.agentMonitorPanel) {
            window.agentMonitorPanel.addLog('Answers refreshed! Check inline comments in PR.', 'success');
          }

          // Reset button to idle
          btn.innerHTML = 'Answer Questions';
          btn.setAttribute('data-state', 'idle');
          btn.disabled = false;
        } else {
          if (window.agentMonitorPanel) {
            window.agentMonitorPanel.addLog('Warning: Some questions may not have been answered', 'error');
          }

          // Reset to idle - user can try again
          btn.innerHTML = 'Answer Questions';
          btn.setAttribute('data-state', 'idle');
          btn.disabled = false;
        }
      } else {
        throw new Error(result.error || 'Failed to answer questions');
      }
    } catch (error) {
      console.error('[AGENT] Error answering questions:', error);

      if (window.agentMonitorPanel) {
        window.agentMonitorPanel.addLog(`Error: ${error.message}`, 'error');
      }

      // Reset button on error
      btn.disabled = false;
      btn.innerHTML = 'Answer Questions';
      btn.setAttribute('data-state', 'idle');
    } finally {
      // Stop heartbeat monitoring
      window.agentClient.stopHeartbeatMonitoring();

      // Close WebSocket connection
      window.agentClient.close();
    }
  }

  async function triggerCopyActionPrompt() {
    const btn = document.getElementById('claude-copy-action-prompt-btn');
    const ultrathinkCheckbox = document.getElementById('claude-ultrathink-checkbox');
    const useUltrathink = ultrathinkCheckbox?.checked || false;

    // Check if there are any actions
    if (!(await hasActions())) {
      alert('No actions to copy. Please mark code sections for action first.');
      return;
    }

    // Check if all actions are already completed
    if (!(await hasIncompleteActions())) {
      alert('All actions have already been completed. Add new actions if you need more work done.');
      return;
    }

    currentPRInfo = getPRInfo();
    if (!currentPRInfo) {
      alert('Could not detect PR information');
      return;
    }

    // Disable button during copy
    btn.disabled = true;
    btn.innerHTML = 'Copying...';

    try {
      const result = await copyActionPromptToClipboard(currentPRInfo, useUltrathink);
      btn.innerHTML = 'Copied!';
      setTimeout(() => {
        btn.innerHTML = 'Copy Action Prompt';
        btn.disabled = false;
      }, 1000);
    } catch (error) {
      console.error('[COPY-PROMPT] Error:', error);
      showNotification(`❌ Failed to copy prompt: ${error.message}`);
      btn.disabled = false;
      btn.innerHTML = 'Copy Action Prompt';
    }
  }

  async function triggerCompleteActions() {
    const btn = document.getElementById('claude-complete-actions-btn');
    const currentState = btn.getAttribute('data-state') || 'idle';

    // Handle different button states. (Both 'running' and the legacy
    // 'view-progress' map to "reopen the monitor panel" — the SDK path sets
    // 'running', so check both to avoid a dead branch.)
    if (currentState === 'view-progress' || currentState === 'running') {
      // User wants to view progress - reopen monitor panel
      if (window.agentMonitorPanel) {
        window.agentMonitorPanel.open();
      }
      return;
    }

    if (currentState === 'refresh') {
      // User wants to refresh page to see changes
      location.reload();
      return;
    }

    // Check if there are any actions
    if (!(await hasActions())) {
      alert('No actions to complete. Please mark code sections for action first.');
      return;
    }

    // Check if all actions are already completed
    if (!(await hasIncompleteActions())) {
      alert('All actions have already been completed. Add new actions if you need more work done.');
      return;
    }

    // Window modes (live subscription window / claude -p) → open a Claude
    // terminal instead of the headless SDK + in-browser panel. (Its own confirm
    // dialog covers billing, so we skip the SDK-oriented actions dialog below.)
    if (isWindowMode(await getRunMode())) {
      await runInteractiveFlow('actions');
      return;
    }

    // Get PR info before showing dialog (needed for "Copy Prompt Instead" button)
    currentPRInfo = getPRInfo();
    if (!currentPRInfo) {
      alert('Could not detect PR information');
      return;
    }

    // Show confirmation dialog
    const decision = await showActionsConfirmationDialog(currentPRInfo);
    if (!decision.proceed) {
      // User cancelled or copied prompt instead
      return;
    }

    // Start new action
    btn.disabled = true;
    btn.innerHTML = 'Starting...';
    btn.setAttribute('data-state', 'starting');

    try {

      // Open monitor panel
      if (window.agentMonitorPanel) {
        window.agentMonitorPanel.clearLogs();
        window.agentMonitorPanel.open();
        window.agentMonitorPanel.updateStatus('Starting...', 'Turn 0/30', 'Initializing...');
        window.agentMonitorPanel.addLog('Starting Claude agent session...', 'info');
      }

      // Start agent session and connect WebSocket
      await window.agentClient.startSession();

      btn.innerHTML = 'View Progress';
      btn.setAttribute('data-state', 'running');
      btn.disabled = false;

      if (window.agentMonitorPanel) {
        window.agentMonitorPanel.updateStatus('Running', 'Turn 1/30', 'Connecting...');
        window.agentMonitorPanel.addLog('Connected to agent server', 'success');
      }

      // Start heartbeat monitoring
      window.agentClient.startHeartbeatMonitoring();

      // Check ultrathink checkbox state
      const ultrathinkCheckbox = document.getElementById('claude-ultrathink-checkbox');
      const useUltrathink = ultrathinkCheckbox?.checked || false;

      // Complete actions using Agent SDK
      const result = await window.agentClient.completeActions(currentPRInfo, useUltrathink);

      if (result.success) {
        // Verify all actions have summaries filled in
        const allCompleted = await verifyAllActionsCompleted();

        if (allCompleted) {
          if (window.agentMonitorPanel) {
            window.agentMonitorPanel.addLog('All actions completed successfully!', 'success');
            window.agentMonitorPanel.addLog('Archiving actions file...', 'info');
          }

          // Archive the completed actions file
          await archiveActionsFile();

          // Clear actions from memory
          clearAllActions();

          if (window.agentMonitorPanel) {
            window.agentMonitorPanel.addLog('Actions archived and cleared from memory', 'success');
          }

          // Change button to "Refresh to see changes"
          btn.innerHTML = 'Refresh to see changes';
          btn.setAttribute('data-state', 'refresh');
          btn.disabled = false;
        } else {
          if (window.agentMonitorPanel) {
            window.agentMonitorPanel.addLog('Warning: Some action summaries may be incomplete', 'error');
          }

          // Reset to idle - user can try again
          btn.innerHTML = 'Start Actions';
          btn.setAttribute('data-state', 'idle');
          btn.disabled = false;
        }
      } else {
        throw new Error(result.error || 'Failed to complete actions');
      }
    } catch (error) {
      console.error('[AGENT] Error completing actions:', error);

      if (window.agentMonitorPanel) {
        window.agentMonitorPanel.addLog(`Error: ${error.message}`, 'error');
        window.agentMonitorPanel.updateStatus('Error', null, 'Failed');
      }

      // Reset button
      btn.disabled = false;
      btn.innerHTML = 'Start Actions';
      btn.setAttribute('data-state', 'idle');
    } finally {
      // Stop heartbeat monitoring
      window.agentClient.stopHeartbeatMonitoring();

      // Close WebSocket connection
      window.agentClient.close();
    }
  }

  // Extract all file contents from the PR diff view
  function extractFileContents() {
    const fileContents = {};
    const files = GHAdapter.getAllFiles();

    files.forEach(file => {
      const fileName = GHAdapter.getFileName(file);
      if (!fileName || fileName === 'unknown-file') return;

      // Walk every diff row. Legacy view uses <tr>; the new view uses divs
      // with data-testid="diff-line" — covered by the adapter's selectors.
      const lines = [];
      const rows = file.querySelectorAll('tr, [data-testid="diff-line"]');

      rows.forEach(row => {
        const lineNumCell = GHAdapter.getRightLineNum(row);
        const codeCell = GHAdapter.getCodeCell(row);

        if (lineNumCell && codeCell) {
          lines.push({
            lineNum: lineNumCell.getAttribute('data-line-number'),
            marker: GHAdapter.getCodeMarker(codeCell),
            code: codeCell.textContent
          });
        }
      });

      fileContents[fileName] = lines;
    });

    return fileContents;
  }

  // Initialize
  function init() {
    // Only run on PR files changed tab
    if (!window.location.pathname.includes('/pull/')) return;

    console.log('Claude GitHub Buddy initialized');

    // Add action buttons at top of PR
    addActionButtons();

    // Listen for clicks (for permalink selections)
    document.addEventListener('click', handleSelection);

    // Track the hovered diff line and (re)mount the Claude button on hover.
    // Pre-1.1.0 the button rode on GitHub's Copilot hover menu; now it anchors
    // via the adapter, driven from here.
    document.addEventListener('mouseover', (e) => {
      // Hovering our own button/menu: keep it alive and pinned.
      if (e.target.closest &&
          e.target.closest('#claude-pr-buddy-button, #claude-dropdown-menu, #claude-fake-copilot')) {
        cancelButtonRemoval();
        return;
      }
      const row = GHAdapter.getLineRow(e.target);
      if (row && GHAdapter.getCodeCell(row)) {
        cancelButtonRemoval();
        currentHoveredRow = row;
        syncWithCopilotButton();
      } else if (!isClaudeButtonActive) {
        // Off the diff — schedule (don't force) removal, so the short hop from a
        // diff line onto the Claude button doesn't flicker it out. If the mouse
        // lands on the button first, the handler above cancels this.
        scheduleButtonRemoval();
      }
    });

    // Watch for Copilot button changes and sync Claude button with it
    copilotObserver = new MutationObserver(() => {
      syncWithCopilotButton();
      // GitHub's React toolbar re-renders and wipes our injected controls, so
      // re-add them whenever they go missing (addActionButtons no-ops if present).
      if (!document.getElementById('claude-action-buttons')) addActionButtons();
    });

    // Observe the entire document for Copilot button appearance/movement
    copilotObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    // Initial sync
    syncWithCopilotButton();

    // Also sync on scroll (in case positioning changes)
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(syncWithCopilotButton, 10);
    });

    // Warn before navigation if agent is active
    window.addEventListener('beforeunload', (e) => {
      const isAgentActive = window.agentClient && window.agentClient.isAgentActive;

      if (isAgentActive) {
        // Standard way to show confirmation dialog on page unload
        e.preventDefault();
        e.returnValue = 'Claude is still working on actions. Are you sure you want to leave?';
        return e.returnValue;
      }
    });

    // Auto-restore from markdown files, then load and display
    autoRestoreFromFiles().then(() => {
      loadAndDisplayAnswers();
      loadAndDisplayActions();
    });
  }

  // Run when page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Handle navigation in GitHub's SPA
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      // Leaving the page invalidates any in-flight interactive run: bump the
      // generation so its poll no-ops, and clear the busy flag so the new view
      // isn't permanently blocked by a run the user navigated away from.
      window._claudeRunGen = (window._claudeRunGen || 0) + 1;
      window._claudeInteractiveBusy = false;
      init();
    }
  }).observe(document, { subtree: true, childList: true });

})();
