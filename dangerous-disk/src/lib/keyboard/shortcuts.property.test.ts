// Feature: json-viewer-free
//
// Property-based test for the keyboard-shortcut registry (`shortcuts.ts`):
//   - Property 31: Clear shortcut empties the editor (Req 19.2)
//
// The clear shortcut acts on the shared `$document` store directly, so it is
// testable without a DOM. For any editor content (arbitrary JSON text or any
// text), invoking the clear action must leave `$document.text === ''`
// (Req 19.2). Invoking the action through the registry's `runShortcut` (the
// real dispatch path) and via the exported `clearEditor` must both hold, and
// clearing an already-empty editor must remain empty (the Req 19.3 no-op edge).

import { afterEach, beforeEach, describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import {
  SHORTCUTS,
  clearEditor,
  runShortcut,
  type Shortcut,
  type ShortcutContext,
} from './shortcuts';
import { $document, setDocumentText } from '../stores/document';
import { serialize } from '../json-core/serialize';
import { jsonArbitrary } from '../../test/arbitraries';

/** The registry's clear shortcut — the entry whose action empties the editor. */
const CLEAR_SHORTCUT: Shortcut = (() => {
  const shortcut = SHORTCUTS.find((s) => s.id === 'clear');
  if (!shortcut) throw new Error('expected a "clear" shortcut in the registry');
  return shortcut;
})();

/**
 * A no-op shortcut context: Property 31 exercises only the document-level clear
 * action, which acts on the shared store and ignores the context entirely.
 */
const noopContext: ShortcutContext = {
  collapseAll: () => {},
  switchTool: () => {},
  openShortcutsHelp: () => {},
};

/**
 * Arbitrary editor text spanning serialized JSON documents (the realistic
 * content) and free-form / edge text (empty, whitespace, unicode).
 */
const editorTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  jsonArbitrary().map((model) => serialize(model)),
  fc.string(),
  fc.fullUnicodeString(),
  fc.constantFrom('', ' ', '\n', '\t', '{}', '[]', 'null', '   spaced   '),
);

// Reset the shared singleton store before/after each case so state does not
// leak between property runs.
function resetStore(): void {
  setDocumentText('');
}

beforeEach(resetStore);
afterEach(resetStore);

describe('Property 31: Clear shortcut empties the editor (Req 19.2)', () => {
  // Feature: json-viewer-free, Property 31: Clear shortcut empties the editor
  // Validates: Requirements 19.2
  test.prop([editorTextArbitrary], { numRuns: 100 })(
    'invoking the clear action on any editor content leaves the editor character count at 0',
    (text) => {
      // Seed the shared editor with arbitrary content.
      setDocumentText(text);

      // Invoke the clear action through the real registry dispatch path.
      runShortcut(CLEAR_SHORTCUT, noopContext);
      expect($document.get().text).toBe('');
      expect($document.get().text.length).toBe(0);

      // Clearing an already-empty editor is a no-op: it stays empty (Req 19.3).
      clearEditor();
      expect($document.get().text).toBe('');

      // The direct exported action behaves identically for re-seeded content.
      setDocumentText(text);
      clearEditor();
      expect($document.get().text).toBe('');
    },
  );
});
