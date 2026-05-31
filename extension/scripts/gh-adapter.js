// gh-adapter.js — single seam for all GitHub DOM access.
//
// GitHub is in the middle of rolling out a TanStack-virtualised React renderer
// for "Files changed". Some accounts/repos still see the legacy table-based
// view (`.file`, `td.blob-num`, `.blob-code-inner`), others see the new view
// (custom elements + `prc-*` / `*-module__*` hashed classnames + `data-testid`s).
// Even within the legacy view, the per-line Copilot side menu
// (`.DiffLinesMenu-module__diff-button-container--fFHPz`) has been removed in
// favour of a per-file `<copilot-diff-entry>` custom element.
//
// Every selector lives here so the rest of the extension doesn't have to know
// which view is active. Each method tries the new view first, falls back to
// legacy.
//
// Verified against legacy view: 2026-05-31, github.com/microsoft/vscode PRs.
// New-view diff selectors are best-effort — confirmed `data-testid` shapes
// (`issue-title`, `comment-header-hamburger`, `prc-Button-ButtonBase-*`) but
// the per-line diff selectors are flagged UNVERIFIED below and will need
// touch-up once a logged-in account on the new view is available.

(function () {
  'use strict';

  const VIEW = { LEGACY: 'legacy', NEW: 'new', UNKNOWN: 'unknown' };

  // Detect which Files-Changed renderer GitHub served us.
  // Legacy: `.file` containers with `td.blob-num` line cells.
  // New: virtualised React tree; `data-testid="issue-title"` on PR header,
  //      no `.js-issue-title`, no `td.blob-num`.
  function detectView() {
    if (document.querySelector('td.blob-num') || document.querySelector('.blob-code-inner')) {
      return VIEW.LEGACY;
    }
    if (document.querySelector('[data-testid="issue-title"]') ||
        document.querySelector('[data-testid^="diff-"]') ||
        document.querySelector('[data-testid^="code-cell"]')) {
      return VIEW.NEW;
    }
    return VIEW.UNKNOWN;
  }

  function getPRInfo() {
    const m = window.location.pathname.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (!m) return null;
    const [, owner, repo, prNumber] = m;

    const prTitle =
      document.querySelector('.js-issue-title')?.textContent?.trim() ||
      document.querySelector('[data-testid="issue-title"]')?.textContent?.trim() ||
      `PR-${prNumber}`;

    let baseBranch = 'unknown';
    let headBranch = 'unknown';

    const base = document.querySelector('.base-ref') ||
                 document.querySelector('[data-testid="base-ref"]');
    const head = document.querySelector('.head-ref') ||
                 document.querySelector('[data-testid="head-ref"]');
    if (base) baseBranch = base.textContent.trim();
    if (head) headBranch = head.textContent.trim();

    return { owner, repo, prNumber, prTitle, fullRepoName: `${owner}/${repo}`, baseBranch, headBranch };
  }

  // Every file container in the diff.
  // Legacy: `.file` (table-based). New view also keeps `.file` inside
  // `<copilot-diff-entry>` for now, so this still works in both.
  // TODO(new-view-verified): if GitHub stops emitting `.file` in the
  // virtualised renderer, switch to `[data-testid="diff-file"]` or
  // `copilot-diff-entry > div` here.
  function getAllFiles() {
    const legacy = document.querySelectorAll('.file');
    if (legacy.length) return legacy;
    return document.querySelectorAll('[data-testid="diff-file"], copilot-diff-entry');
  }

  // Filename for a given file element. The new `<copilot-diff-entry>` carries
  // it on `data-file-path`, which is cleaner than the old title-attribute walk.
  function getFileName(fileElement) {
    if (!fileElement) return 'unknown-file';
    const cde = fileElement.closest('copilot-diff-entry') ||
                fileElement.querySelector('copilot-diff-entry');
    const cdePath = cde?.getAttribute('data-file-path');
    if (cdePath) return cdePath;

    const titled = fileElement.querySelector('.file-header [title]');
    if (titled) return titled.getAttribute('title') || 'unknown-file';

    const dataPath = fileElement.querySelector('.file-header[data-path]')?.getAttribute('data-path') ||
                     fileElement.getAttribute('data-tagsearch-path');
    return dataPath || 'unknown-file';
  }

  // Walk from any element inside a file's diff up to that file's container.
  function findFileFromLine(element) {
    if (!element) return null;
    return element.closest('copilot-diff-entry') ||
           element.closest('[data-testid="diff-file"]') ||
           element.closest('.file');
  }

  // The line-number cell for a specific line number within a file element.
  // Legacy: `td.blob-num[data-line-number=N]`.
  // TODO(new-view-verified): the virtualised renderer almost certainly uses
  // `[data-testid="diff-line-number"][data-line-number]` or similar; verify
  // and add the fallback here.
  function getLineCell(fileElement, lineNum) {
    if (!fileElement) return null;
    return fileElement.querySelector(`td.blob-num[data-line-number="${lineNum}"]`) ||
           fileElement.querySelector(`[data-testid="diff-line-number"][data-line-number="${lineNum}"]`);
  }

  // The right-side (new file) line-number cell for a diff row. Used when we
  // need the post-change line number (right side of a split diff or unified +).
  function getRightLineNum(row) {
    if (!row) return null;
    return row.querySelector('td.blob-num.js-blob-rnum[data-line-number]') ||
           row.querySelector('td.blob-num[data-line-number]') ||
           row.querySelector('[data-testid="diff-line-number-right"][data-line-number]') ||
           row.querySelector('[data-testid="diff-line-number"][data-line-number]');
  }

  // The actual code-text cell for a diff row.
  function getCodeCell(row) {
    if (!row) return null;
    return row.querySelector('.blob-code .blob-code-inner') ||
           row.querySelector('[data-testid="diff-code-cell"]') ||
           row.querySelector('[data-testid="code-cell"]');
  }

  // Diff marker ('+', '-', ' ') for a code cell. Legacy puts it on the
  // `data-code-marker` attribute. In the new view it's not yet confirmed; we
  // fall back to reading the first character of the rendered cell text when
  // no attribute is present.
  function getCodeMarker(codeCell) {
    if (!codeCell) return ' ';
    const attr = codeCell.getAttribute('data-code-marker');
    if (attr) return attr;
    const text = codeCell.textContent || '';
    const first = text.charAt(0);
    return (first === '+' || first === '-') ? first : ' ';
  }

  // The clickable row wrapping a code/line cell. Legacy diff rows are `<tr>`s;
  // the new view uses divs, so we walk up looking for either.
  function getLineRow(element) {
    if (!element) return null;
    return element.closest('tr') ||
           element.closest('[data-testid="diff-line"]') ||
           element.parentElement;
  }

  // All currently-highlighted (permalink-selected) diff lines.
  function getSelectedLines() {
    return document.querySelectorAll('.blob-code.selected-line, [data-testid="diff-line"][data-selected="true"]');
  }

  // Where the Claude button should mount. Strategy:
  //  1. If a line is currently selected, anchor next to the first selected
  //     line's right edge.
  //  2. Otherwise, fall back to the old per-line Copilot side menu if it
  //     still exists (it doesn't on the legacy view as of 2026-05, but kept
  //     as a defensive fallback).
  //  3. Otherwise return null — caller should hide the button.
  //
  // Returns `{ left, top }` in document coordinates, or null.
  function findMountPosition() {
    const selected = getSelectedLines()[0];
    if (selected) {
      const row = getLineRow(selected);
      const target = row || selected;
      const rect = target.getBoundingClientRect();
      // Anchor to the right edge of the diff row with a small inset so the
      // button overlaps the gutter rather than the code text.
      return {
        left: rect.right - 80,
        top: rect.top + window.scrollY + 1,
        anchorRect: rect,
      };
    }

    // Defensive: legacy per-line Copilot anchor (no longer present on either
    // view, but if GitHub ships it back this kicks in for free).
    const copilotContainer = document.querySelector('.DiffLinesMenu-module__diff-button-container--fFHPz, [class*="DiffLinesMenu-module__diff-button-container"]');
    const copilotButton = document.querySelector('[data-testid="copilot-ask-menu"]');
    if (copilotContainer && copilotButton) {
      const rect = copilotContainer.getBoundingClientRect();
      return {
        left: rect.left - 19 - 60,
        top: rect.top + window.scrollY + 1,
        anchorRect: rect,
      };
    }

    return null;
  }

  window.GHAdapter = {
    VIEW,
    detectView,
    getPRInfo,
    getAllFiles,
    getFileName,
    findFileFromLine,
    getLineCell,
    getRightLineNum,
    getCodeCell,
    getCodeMarker,
    getLineRow,
    getSelectedLines,
    findMountPosition,
  };
})();
