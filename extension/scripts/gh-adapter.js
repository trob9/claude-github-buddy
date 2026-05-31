// gh-adapter.js — single seam for all GitHub DOM access.
//
// GitHub ships two "Files changed" renderers:
//
//   • LEGACY  — `.file`, `td.blob-num[data-line-number]`,
//     `.blob-code .blob-code-inner`, `data-code-marker` attributes.
//
//   • NEW ("new experience") — a React `role="grid"` <table>. VERIFIED against
//     a saved new-experience PR page (2026-05):
//       - Each file's diff table is `[data-diff-anchor="diff-<sha>"]`; the file
//         PATH lives on a `[data-file-path]` element in that file's header.
//       - Rows are `<tr class="diff-line-row" data-row-selected="false">`.
//       - Line-number cells are `<td ... data-line-number="47"
//         data-diff-side="left|right" class="... diff-line-number-neutral">47`
//         — the `data-line-number` ATTRIBUTE still exists (two per row: a
//         left/old side and a right/new side).
//       - The code cell is `td.diff-text-cell`, text inside `.diff-text-inner`.
//         There is no `data-code-marker`; add/del is encoded in the line-number
//         cell class (`diff-line-number-addition` / `-deletion` / `-neutral`).
//       - Selection is `data-selected="true"` on cells / `data-row-selected
//         ="true"` on rows.
//
// Every selector lives here so the rest of the extension doesn't care which
// view is active. The selector sets are disjoint, so order is harmless.

(function () {
  'use strict';

  const VIEW = { LEGACY: 'legacy', NEW: 'new', UNKNOWN: 'unknown' };

  function detectView() {
    if (document.querySelector('td.blob-num') || document.querySelector('.blob-code-inner')) {
      return VIEW.LEGACY;
    }
    if (document.querySelector('[data-diff-anchor], tr.diff-line-row, [data-grid-cell-id]')) {
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

    // Legacy view: explicit base-ref / head-ref elements.
    const base = document.querySelector('.base-ref') ||
                 document.querySelector('[data-testid="base-ref"]');
    const head = document.querySelector('.head-ref') ||
                 document.querySelector('[data-testid="head-ref"]');
    if (base) baseBranch = base.textContent.trim();
    if (head) headBranch = head.textContent.trim();

    // New experience: branches are `[data-component="BranchName"]` links whose
    // href is `/owner/repo/tree/<branch>`. The header reads "merged into <base>
    // from <head>", so the first distinct branch is the base and the second is
    // the head. The href is more reliable than textContent (which truncates).
    if (baseBranch === 'unknown' || headBranch === 'unknown') {
      const branchEls = document.querySelectorAll('[data-component="BranchName"], a.prc-BranchName-BranchName-CMTaU');
      const treePrefix = `/${owner}/${repo}/tree/`;
      const seen = [];
      branchEls.forEach(el => {
        let name = '';
        const href = el.getAttribute('href') || '';
        const idx = href.indexOf('/tree/');
        if (href.startsWith(treePrefix)) {
          name = decodeURIComponent(href.slice(treePrefix.length));
        } else if (idx !== -1) {
          name = decodeURIComponent(href.slice(idx + '/tree/'.length));
        } else {
          name = (el.textContent || '').trim();
        }
        name = name.replace(/\s+/g, '');
        if (name && !seen.includes(name)) seen.push(name);
      });
      if (seen.length >= 2) {
        if (baseBranch === 'unknown') baseBranch = seen[0];
        if (headBranch === 'unknown') headBranch = seen[1];
      } else if (seen.length === 1 && headBranch === 'unknown') {
        // Only one resolvable branch — assume it's the head (source) branch.
        headBranch = seen[0];
      }
    }

    return { owner, repo, prNumber, prTitle, fullRepoName: `${owner}/${repo}`, baseBranch, headBranch };
  }

  // Every file container in the diff.
  function getAllFiles() {
    const legacy = document.querySelectorAll('.file');
    if (legacy.length) return legacy;
    // New experience: one diff <table> per file.
    return document.querySelectorAll('copilot-diff-entry, [data-testid="diff-file"], [data-diff-anchor]');
  }

  // Filename for a given file element.
  function getFileName(fileElement) {
    if (!fileElement) return 'unknown-file';

    // Legacy <copilot-diff-entry data-file-path>.
    const cde = fileElement.closest?.('copilot-diff-entry') ||
                fileElement.querySelector?.('copilot-diff-entry');
    const cdePath = cde?.getAttribute('data-file-path');
    if (cdePath) return cdePath;

    // New experience: a [data-file-path] element lives in the file's header.
    // It may be a sibling of the diff table, so search the element, then walk
    // up a few levels looking for a [data-file-path] descendant.
    const direct = fileElement.closest?.('[data-file-path]')?.getAttribute('data-file-path') ||
                   fileElement.querySelector?.('[data-file-path]')?.getAttribute('data-file-path');
    if (direct) return direct;

    let node = fileElement.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const p = node.querySelector?.('[data-file-path]');
      if (p) return p.getAttribute('data-file-path');
      node = node.parentElement;
    }

    // Legacy header title attribute.
    const titled = fileElement.querySelector?.('.file-header [title]');
    if (titled) return titled.getAttribute('title') || 'unknown-file';

    return 'unknown-file';
  }

  // Walk from any element inside a file's diff up to that file's container.
  function findFileFromLine(element) {
    if (!element) return null;
    return element.closest('copilot-diff-entry') ||
           element.closest('[data-testid="diff-file"]') ||
           element.closest('[data-diff-anchor]') ||
           element.closest('.file');
  }

  // The line-number cell for a specific line number within a file element.
  // Prefer the right-hand (new file) side.
  function getLineCell(fileElement, lineNum) {
    if (!fileElement) return null;

    const legacy = fileElement.querySelector(`td.blob-num[data-line-number="${lineNum}"]`);
    if (legacy) return legacy;

    return fileElement.querySelector(`[data-diff-side="right"][data-line-number="${lineNum}"]`) ||
           fileElement.querySelector(`[data-line-number="${lineNum}"]`);
  }

  // The right-side (new file) line-number cell for a diff row. In both views
  // this is a real element with a `data-line-number` attribute, so callers can
  // keep using `.getAttribute('data-line-number')`.
  function getRightLineNum(row) {
    if (!row) return null;
    return row.querySelector('td.blob-num.js-blob-rnum[data-line-number]') ||
           row.querySelector('td.blob-num[data-line-number]') ||
           row.querySelector('[data-diff-side="right"][data-line-number]') ||
           row.querySelector('[data-line-number]');
  }

  // The code-text cell for a diff row. New view: `.diff-text-inner` holds the
  // clean code text (no marker char); legacy: `.blob-code-inner`.
  function getCodeCell(row) {
    if (!row) return null;
    return row.querySelector('.blob-code .blob-code-inner') ||
           row.querySelector('[data-testid="diff-code-cell"]') ||
           row.querySelector('.diff-text-inner') ||
           row.querySelector('td.diff-text-cell');
  }

  // Diff marker ('+', '-', ' ') for a code cell.
  function getCodeMarker(codeCell) {
    if (!codeCell) return ' ';

    const attr = codeCell.getAttribute('data-code-marker');
    if (attr) return attr;

    // New experience: add/del is encoded in the row's line-number cell class.
    const row = codeCell.closest('tr') || codeCell.parentElement;
    const cls = (row?.querySelector('[class*="diff-line-number-"]')?.className || '') +
                ' ' + (row?.className || '') + ' ' + (codeCell.className || '');
    if (/addition/i.test(cls)) return '+';
    if (/deletion/i.test(cls)) return '-';

    const text = codeCell.textContent || '';
    const first = text.charAt(0);
    return (first === '+' || first === '-') ? first : ' ';
  }

  // The row wrapping a code/line cell. Both views use a real <table>.
  function getLineRow(element) {
    if (!element || !element.closest) return null;
    // Only treat genuine diff rows as line rows. Never fall back to an
    // arbitrary parent — otherwise hovering page chrome (e.g. the header
    // "Code" button) is mistaken for a diff line and the button drifts there.
    return element.closest('tr.diff-line-row, [data-testid="diff-line"], tr');
  }

  // All currently-highlighted (permalink-selected) diff lines/rows.
  function getSelectedLines() {
    return document.querySelectorAll(
      '.blob-code.selected-line, ' +
      'tr.diff-line-row[data-row-selected="true"], ' +
      '[data-line-number][data-selected="true"]'
    );
  }

  // GitHub's per-line hover menu (the triangle-down dropdown that appears in
  // the gutter on hover). Best effort: the new view only injects it on hover,
  // so prefer one inside the currently-hovered row.
  function findHoverMenu(hoveredRow) {
    if (hoveredRow) {
      const tri = hoveredRow.querySelector('button svg.octicon-triangle-down, button svg.octicon-kebab-horizontal');
      if (tri) return tri.closest('button');
      const lineMenu = hoveredRow.querySelector('[class*="LineMenu"] button, [class*="line-menu"] button, button[class*="LineMenu"], button[class*="line-menu"]');
      if (lineMenu) return lineMenu;
    }
    // Legacy per-line Copilot menu, if GitHub still serves it.
    const byClass = document.querySelector('[class*="DiffLinesMenu-module__diff-button-container"]');
    if (byClass) return byClass;
    const copilot = document.querySelector('[data-testid="copilot-ask-menu"]');
    if (copilot) return copilot.closest('[class*="diff-button-container"]') || copilot;
    return null;
  }

  // The stable per-row anchor cell. GitHub's triangle-down hover menu only
  // exists while the mouse is on the line, so anchoring to IT makes the Claude
  // button jump when the menu appears/disappears. Instead we anchor to the
  // line-number gutter cell, which is ALWAYS present in the row — so the
  // computed position is identical on every recompute (no shift), and still
  // tracks correctly on scroll.
  function getRowAnchorCell(row) {
    if (!row || !row.querySelector) return row;
    return row.querySelector('td.blob-num.js-blob-rnum[data-line-number]') ||
           row.querySelector('[data-diff-side="right"][data-line-number]') ||
           row.querySelector('[data-line-number]') ||
           row.querySelector('td.blob-num') ||
           row;
  }

  // Where the Claude button should mount. Priority:
  //  1. A currently-selected diff line → anchor to that row.
  //  2. The legacy Copilot side-menu (old experience only), when not hovering.
  //  3. The hovered diff row → anchored to the row's RIGHT edge (new experience).
  //  4. null → caller hides the button.
  //
  // Button size (kept in sync with CSS) for placement maths.
  const BTN_W = 54;
  const BTN_H = 22;

  // Anchor to a diff row's right edge, vertically centred on the line. The row
  // is ALWAYS present (unlike GitHub's hover menu, which only exists while the
  // mouse is on the line), so the computed X is identical on every recompute —
  // no sideways jump — and it sits on the right where the Copilot menu used to
  // be, not jammed against the line-number gutter on the left.
  function anchorToRow(row) {
    const rect = row.getBoundingClientRect();
    const top = rect.top + window.scrollY + Math.round((rect.height - BTN_H) / 2);
    // Keep it just inside the row's right edge, and never off the right of the
    // viewport for very wide diffs.
    const maxLeft = window.innerWidth - BTN_W - 14;
    const left = Math.min(rect.right - BTN_W - 26, maxLeft);
    return { left, top, anchorRect: rect };
  }

  function findMountPosition(hoveredRow) {
    const selected = getSelectedLines()[0];
    if (selected) {
      const row = getLineRow(selected);
      if (row) return anchorToRow(row);
    }

    // Legacy Copilot side-menu (old table view). Only when we're not anchoring
    // to a hovered row, since the new view's per-line menu is ephemeral.
    if (!hoveredRow) {
      const legacy = document.querySelector(
        '[class*="DiffLinesMenu-module__diff-button-container"], [data-testid="copilot-ask-menu"]'
      );
      if (legacy) {
        const rect = legacy.getBoundingClientRect();
        return { left: rect.left - 19 - 60, top: rect.top + window.scrollY + 1, anchorRect: rect };
      }
    }

    if (hoveredRow) {
      return anchorToRow(hoveredRow);
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
    findHoverMenu,
    getRowAnchorCell,
    findMountPosition,
  };
})();
