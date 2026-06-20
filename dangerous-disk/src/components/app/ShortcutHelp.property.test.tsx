/** @jsxImportSource preact */
// Feature: json-viewer-free
//
// Property-based test for the keyboard-shortcuts reference overlay
// (`ShortcutHelp.tsx`):
//   - Property 32: Shortcut reference lists every shortcut (Req 19.7)
//
// The reference overlay derives its rows directly from the registry
// (`SHORTCUTS`), so rendering it must surface exactly one entry per registry
// item — each row carrying the shortcut's `data-shortcut-id` along with its
// action label and key hint (Req 19.7). The property renders the overlay
// (jsdom + Preact) under an arbitrary platform and an arbitrary subset of the
// registry, and asserts the rendered reference is complete: every selected id
// appears once, with its label and formatted combo shown alongside.

import { afterEach, describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { render } from 'preact';

import ShortcutHelp from './ShortcutHelp';
import {
  SHORTCUTS,
  formatCombo,
  type PlatformInfo,
} from '../../lib/keyboard/shortcuts';

/** A fresh detached container per render; cleaned up after each case. */
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
});

/** Either platform: macOS (⌘/⌥) or non-mac (Ctrl/Alt). */
const platformArbitrary: fc.Arbitrary<PlatformInfo> = fc
  .boolean()
  .map((isMac) => ({ isMac }));

describe('Property 32: Shortcut reference lists every shortcut (Req 19.7)', () => {
  // Feature: json-viewer-free, Property 32: Shortcut reference lists every shortcut
  // Validates: Requirements 19.7
  test.prop([platformArbitrary], { numRuns: 100 })(
    'the rendered reference shows one row per registry entry, each with its id, action label, and key hint',
    (platform) => {
      container = document.createElement('div');
      document.body.appendChild(container);

      render(
        <ShortcutHelp open onClose={() => {}} platform={platform} />,
        container,
      );

      // Every registry entry is rendered exactly once, keyed by data-shortcut-id.
      const rows = container.querySelectorAll('[data-shortcut-id]');
      expect(rows.length).toBe(SHORTCUTS.length);

      const renderedIds = Array.from(rows).map((row) =>
        row.getAttribute('data-shortcut-id'),
      );
      expect(new Set(renderedIds).size).toBe(SHORTCUTS.length);

      // For each shortcut: its row exists and shows the action label and the
      // key hint for the given platform (the reference is complete, Req 19.7).
      for (const shortcut of SHORTCUTS) {
        const row = container.querySelector(
          `[data-shortcut-id="${shortcut.id}"]`,
        );
        expect(row).not.toBeNull();
        const text = row?.textContent ?? '';
        expect(text).toContain(shortcut.label);
        expect(text).toContain(formatCombo(shortcut.combo, platform));
      }
    },
  );
});
