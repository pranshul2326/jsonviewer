// Feature: json-viewer-free — document store unit tests
//
// Validates: Requirements 21.5, 21.6
//
// Req 21.5: "WHEN a user switches from a source tool to a target tool that both
//  operate on a single shared document, THE Application SHALL load the current
//  Editor content into the target tool unchanged, preserving all characters,
//  whitespace, and ordering."
// Req 21.6: "IF a user switches to a target tool that does not operate on the
//  shared single document, THEN THE Application SHALL retain the current Editor
//  content in memory so that it is restored unchanged when the user returns to a
//  tool that operates on the shared single document."
//
// The shared `$document` store is the single source of truth backing every
// tool. These tests assert that changing the active tool (`$activeTool`) and
// updating settings (`$settings`) never mutate the document text — it stays
// byte-for-byte identical — and that the parsed model is preserved across tool
// switches (no re-parse is needed because the store keeps it alive).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  $document,
  $activeTool,
  $settings,
  setDocumentText,
  setActiveTool,
  setIndentStyle,
  setRichMediaEnabled,
  type Tool,
} from './document';

/** A document with assorted characters, whitespace, ordering and precision. */
const SAMPLE_TEXT = [
  '{',
  '  "z": 1,',
  '  "a": [true, null, "héllo\\tworld", 3.141592653589793238462643],',
  '  "nested": { "b": 2, "a": 1 },',
  '  "unicode": "✓ \\u00e9 emoji 😀",',
  '  "ws":   "  spaced  "  ',
  '}',
  '',
].join('\n');

/** The four tools, used to exercise every switch combination. */
const TOOLS: Tool[] = ['viewer', 'diff', 'grid', 'converter'];

// Reset the shared stores before and after each test so the singletons do not
// leak state between cases.
function resetStores(): void {
  setDocumentText('');
  setActiveTool('viewer');
  setIndentStyle({ kind: 'space', size: 2 });
  setRichMediaEnabled(true);
}

beforeEach(resetStores);
afterEach(resetStores);

describe('$document text retention across tool changes (Req 21.5, 21.6)', () => {
  it('retains the document text byte-for-byte across a single tool switch', () => {
    setDocumentText(SAMPLE_TEXT);

    setActiveTool('grid');

    expect($document.get().text).toBe(SAMPLE_TEXT);
  });

  it('retains the document text byte-for-byte across every pair of tool switches', () => {
    setDocumentText(SAMPLE_TEXT);

    for (const from of TOOLS) {
      for (const to of TOOLS) {
        setActiveTool(from);
        setActiveTool(to);
        expect($document.get().text).toBe(SAMPLE_TEXT);
      }
    }
  });

  it('restores the document text unchanged after switching away and back (Req 21.6)', () => {
    setDocumentText(SAMPLE_TEXT);

    // Switch to a tool, then return to the viewer; the text must be intact.
    setActiveTool('diff');
    setActiveTool('converter');
    setActiveTool('viewer');

    expect($document.get().text).toBe(SAMPLE_TEXT);
  });

  it('preserves leading/trailing whitespace and ordering exactly', () => {
    const whitespaceHeavy = '\n\t  {"b":1,"a":2}   \n  ';
    setDocumentText(whitespaceHeavy);

    setActiveTool('grid');
    setActiveTool('diff');

    expect($document.get().text).toBe(whitespaceHeavy);
  });

  it('retains an invalid-JSON document verbatim across tool switches', () => {
    const invalid = '{ "broken": }';
    setDocumentText(invalid);

    setActiveTool('converter');

    const state = $document.get();
    expect(state.text).toBe(invalid);
    // The parsed result is preserved alongside the text — still an error.
    expect(state.parsed.ok).toBe(false);
  });
});

describe('$document text retention across settings updates (Req 21.5, 21.6)', () => {
  it('leaves the document text unchanged when the indent style changes', () => {
    setDocumentText(SAMPLE_TEXT);

    setIndentStyle({ kind: 'tab' });
    setIndentStyle({ kind: 'space', size: 4 });

    expect($document.get().text).toBe(SAMPLE_TEXT);
  });

  it('leaves the document text unchanged when rich media is toggled', () => {
    setDocumentText(SAMPLE_TEXT);

    setRichMediaEnabled(false);
    setRichMediaEnabled(true);

    expect($document.get().text).toBe(SAMPLE_TEXT);
  });

  it('leaves the document text unchanged across combined tool + settings changes', () => {
    setDocumentText(SAMPLE_TEXT);

    setActiveTool('grid');
    setIndentStyle({ kind: 'tab' });
    setActiveTool('diff');
    setRichMediaEnabled(false);
    setActiveTool('viewer');

    expect($document.get().text).toBe(SAMPLE_TEXT);
  });
});

describe('$document parsed model is preserved across tool switches (Req 21.5)', () => {
  it('keeps the exact same parsed model object across tool switches (no re-parse)', () => {
    setDocumentText('{"a":1,"b":[2,3]}');

    const parsedBefore = $document.get().parsed;

    setActiveTool('grid');
    setActiveTool('converter');
    setActiveTool('viewer');

    const parsedAfter = $document.get().parsed;

    // Same object reference: the store holds the model alive rather than
    // recomputing it on every tool switch.
    expect(parsedAfter).toBe(parsedBefore);
    expect(parsedAfter.ok).toBe(true);
  });

  it('keeps the parsed model in sync with the retained text', () => {
    setDocumentText('[1,2,3]');

    setActiveTool('diff');

    const state = $document.get();
    expect(state.text).toBe('[1,2,3]');
    expect(state.parsed.ok).toBe(true);
    if (state.parsed.ok && !state.parsed.empty) {
      expect(state.parsed.model).not.toBeNull();
    }
  });
});
