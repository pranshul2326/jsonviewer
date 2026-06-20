// Feature: json-viewer-free
//
// Property-based test for the shared document store (`document.ts`):
//   - Property 34: Tool switching preserves the shared document (Req 21.5, 21.6)
//
// The four tools (Viewer, Diff Checker, Table Grid, Converter) are all backed by
// the single shared `$document` store. Per Req 21.5 switching between tools that
// operate on the shared document loads the editor content unchanged, and per
// Req 21.6 switching to a tool that does not operate on the shared document still
// retains the content in memory so it is restored unchanged when returning.
//
// This property generates an arbitrary JSON document (serialized to editor text
// via the shared arbitraries) and an arbitrary sequence of `setActiveTool` calls
// among the four tools, then asserts that throughout the entire sequence the
// shared document text is preserved byte-for-byte and the parsed model is
// preserved (same object reference and structurally equal — no re-parse).

import { afterEach, beforeEach, describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import {
  $document,
  $activeTool,
  setDocumentText,
  setActiveTool,
  type Tool,
} from './document';
import { serialize } from '../json-core/serialize';
import { jsonArbitrary, structuralEquals } from '../../test/arbitraries';

/** The four primary tools that can be activated (Req 21.1). */
const TOOLS: Tool[] = ['viewer', 'diff', 'grid', 'converter'];

/** A non-empty sequence of tool switches drawn from the four tools. */
const toolSequenceArbitrary = fc.array(fc.constantFrom(...TOOLS), {
  minLength: 1,
  maxLength: 20,
});

// Reset the shared singleton stores before and after each case so state does
// not leak between property runs.
function resetStores(): void {
  setDocumentText('');
  setActiveTool('viewer');
}

beforeEach(resetStores);
afterEach(resetStores);

describe('Property 34: Tool switching preserves the shared document (Req 21.5, 21.6)', () => {
  // Feature: json-viewer-free, Property 34: Tool switching preserves the shared document
  // Validates: Requirements 21.5, 21.6
  test.prop([jsonArbitrary(), toolSequenceArbitrary], { numRuns: 100 })(
    'an arbitrary sequence of tool switches preserves the document text byte-for-byte and the parsed model',
    (model, toolSequence) => {
      // Seed the shared document with the serialized text of the model.
      const text = serialize(model);
      setDocumentText(text);

      // Snapshot the document state immediately after loading. The parsed model
      // reference is what we expect to survive every switch (no re-parse).
      const parsedBefore = $document.get().parsed;
      expect($document.get().text).toBe(text);

      // Walk the random sequence of tool switches; after each one the shared
      // document must be untouched.
      for (const tool of toolSequence) {
        setActiveTool(tool);

        // The active tool reflects the switch...
        expect($activeTool.get()).toBe(tool);

        // ...but the shared document text is preserved byte-for-byte (Req 21.5,
        // 21.6: all characters, whitespace, and ordering).
        const state = $document.get();
        expect(state.text).toBe(text);

        // The parsed model is preserved: same object reference (the store keeps
        // it alive rather than recomputing it on each switch).
        expect(state.parsed).toBe(parsedBefore);

        // And it is structurally equal to the original model when present.
        if (state.parsed.ok && !state.parsed.empty) {
          expect(structuralEquals(state.parsed.model, model)).toBe(true);
        }
      }

      // After the whole sequence the document text remains identical.
      expect($document.get().text).toBe(text);
    },
  );
});
