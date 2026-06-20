// Feature: json-viewer-free — editor marker-mapping unit tests (Task 12.3)
//
// Validates: Requirements 6.4, 6.5, 6.6
//
// These tests cover the pure ParseResult -> inline-marker mapping the EditorPane
// uses. Monaco's real editor/workers are not available under jsdom, so the
// marker-derivation logic was extracted into `markersForParseResult` (a Monaco-
// free function) and is exercised here directly, driven by the authoritative
// `parseJson` validator:
//
//   Req 6.4: a syntax error reports the first error's type and 1-based
//            line/column. The marker is positioned at that exact line/column.
//   Req 6.5: that position is highlighted inline (a single-character marker at
//            the reported line/column).
//   Req 6.6: when content becomes valid, all previously displayed inline error
//            highlights are cleared (the mapping yields no markers).

import { describe, expect, it } from 'vitest';
import { parseJson } from '../../lib/json-core/parse';
import { markersForParseResult } from './editor-markers';

describe('markersForParseResult — valid content (Req 6.6)', () => {
  it('yields no markers for a valid object', () => {
    const result = parseJson('{"a":1,"b":[2,3]}');
    expect(result.ok).toBe(true);
    expect(markersForParseResult(result)).toEqual([]);
  });

  it('yields no markers for empty input (valid-empty, Req 6.3/6.6)', () => {
    expect(markersForParseResult(parseJson(''))).toEqual([]);
  });

  it('yields no markers for whitespace-only input (valid-empty)', () => {
    expect(markersForParseResult(parseJson('   \n\t  '))).toEqual([]);
  });
});

describe('markersForParseResult — syntax error placement (Req 6.4, 6.5)', () => {
  it('produces exactly one marker for a syntax error', () => {
    const result = parseJson('{ "a": }');
    expect(result.ok).toBe(false);
    expect(markersForParseResult(result)).toHaveLength(1);
  });

  it('positions the marker at the first error 1-based line/column', () => {
    const result = parseJson('{ "a": }');
    // Sanity-check the validator located the error before asserting the marker.
    if (result.ok) throw new Error('expected a parse error');
    const { line, column } = result.error;

    const [marker] = markersForParseResult(result);
    expect(marker.startLineNumber).toBe(line);
    expect(marker.startColumn).toBe(column);
  });

  it('highlights a single character at the error position (Req 6.5)', () => {
    const result = parseJson('{ "a": }');
    const [marker] = markersForParseResult(result);
    // Same line, one column wide so the offending character is highlighted.
    expect(marker.endLineNumber).toBe(marker.startLineNumber);
    expect(marker.endColumn).toBe(marker.startColumn + 1);
  });

  it('reports the error on the correct line for a multi-line document', () => {
    // The colon is missing on the second line.
    const text = '{\n  "a" 1\n}';
    const result = parseJson(text);
    if (result.ok) throw new Error('expected a parse error');
    const { line, column } = result.error;

    const [marker] = markersForParseResult(result);
    expect(marker.startLineNumber).toBe(line);
    expect(marker.startColumn).toBe(column);
    // The error is on the second line, not the first.
    expect(marker.startLineNumber).toBe(2);
  });

  it('carries the validator error type and message onto the marker', () => {
    const result = parseJson('{ "a": }');
    if (result.ok) throw new Error('expected a parse error');
    const { type, message } = result.error;

    const [marker] = markersForParseResult(result);
    expect(marker.source).toBe(type);
    expect(marker.message).toBe(message);
  });
});

describe('markersForParseResult — invalid -> valid transition clears markers (Req 6.6)', () => {
  it('drops from one marker to none when content becomes valid', () => {
    const invalid = parseJson('{ "a": }');
    expect(markersForParseResult(invalid)).toHaveLength(1);

    // The same text, now corrected, must clear the inline highlight.
    const valid = parseJson('{ "a": 1 }');
    expect(markersForParseResult(valid)).toEqual([]);
  });
});
