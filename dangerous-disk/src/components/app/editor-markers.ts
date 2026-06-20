// Feature: json-viewer-free
//
// editor-markers — the pure mapping from a `ParseResult` to the inline editor
// markers the EditorPane displays (Req 6.4, 6.5, 6.6).
//
// This logic is deliberately kept free of any Monaco import so it can be unit
// tested under jsdom, where Monaco's real editor and language workers are not
// available. `EditorPane` consumes `markersForParseResult` and only layers the
// Monaco-specific `severity` enum on top before calling `setModelMarkers`.
//
//   - A valid result (including the empty/whitespace valid-empty state) yields
//     an empty marker list, which clears any previously displayed inline error
//     highlight (Req 6.5, 6.6).
//   - An error result yields exactly one marker positioned at the first error's
//     1-based line/column, highlighting a single character at that position
//     (Req 6.4, 6.5). Monaco positions are 1-based, matching our parser.

import type { ParseResult } from '../../lib/json-core/parse';

/**
 * A Monaco-compatible marker descriptor without the engine-specific severity
 * enum. `EditorPane` adds `severity: MarkerSeverity.Error` before handing this
 * to Monaco. All positions are 1-based.
 */
export interface ValidationMarker {
  /** 1-based line of the first error. */
  startLineNumber: number;
  /** 1-based column of the first error. */
  startColumn: number;
  /** Same line as {@link startLineNumber} — the error is highlighted on one line. */
  endLineNumber: number;
  /** One past {@link startColumn}, highlighting a single character. */
  endColumn: number;
  /** The validator's descriptive error message. */
  message: string;
  /** The error type (e.g. `"ColonExpected"`), surfaced as the marker source. */
  source: string;
}

/**
 * Map a parse result to the inline markers the editor should display.
 *
 * Returns an empty array for any valid result (clearing markers, Req 6.6), or a
 * single marker at the first error's 1-based line/column (Req 6.4, 6.5).
 */
export function markersForParseResult(result: ParseResult): ValidationMarker[] {
  if (result.ok) {
    // Valid (including empty/whitespace): no markers — clears prior highlights.
    return [];
  }

  const { line, column, message, type } = result.error;
  return [
    {
      startLineNumber: line,
      startColumn: column,
      endLineNumber: line,
      // Highlight at least one character at the error position.
      endColumn: column + 1,
      message,
      source: type,
    },
  ];
}
