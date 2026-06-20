// Feature: json-viewer-free
//
// `parseJson` — the single entry point that turns JSON text into the in-memory
// `JsonNode` model used by every tool.
//
// Design (see design.md "Key Interfaces (json-core)" and Req 1.1, 6.4):
//   - The success path uses `lossless-json`'s strict `parse` purely as a
//     validity gate (it rejects comments, trailing commas, duplicate keys, and
//     malformed tokens). The `JsonNode` model itself is built from
//     `jsonc-parser`'s concrete syntax tree via `fromJsoncTree`, which preserves
//     object key order, array order, full numeric precision (raw lexemes sliced
//     from source), and — crucially — object keys that collide with
//     `Object.prototype` accessors such as `__proto__` (which `lossless-json`'s
//     plain-object value tree silently drops).
//   - Empty or whitespace-only input is *valid* and produces a dedicated
//     valid-empty result with no model (Req 6.3): the validator shows the
//     valid-state indicator and the tree simply has nothing to render.
//   - On a syntax error, `jsonc-parser`'s error-recovering `parseTree` locates
//     the first error in reading order and reports its error *type* together
//     with a 1-based line and column (Req 6.4).
//
// The result is a discriminated union so callers can distinguish a parsed
// model, the valid-empty state, and an error with a precise location.

import { parse as parseLossless } from 'lossless-json';
import {
  parseTree,
  printParseErrorCode,
  type Node as JsoncNode,
  type ParseError as JsoncParseError,
  type ParseOptions,
} from 'jsonc-parser';
import { fromJsoncTree } from './model';
import type { JsonNode } from './types';

/** A located syntax error, with 1-based line/column (Req 6.4). */
export interface ParseErrorInfo {
  /** Human-readable error type, e.g. `"ColonExpected"`. */
  type: string;
  /** 1-based line number of the first error. */
  line: number;
  /** 1-based column number of the first error. */
  column: number;
  /** A descriptive message combining the type and location. */
  message: string;
}

/**
 * The outcome of parsing JSON text.
 *
 *   - `{ ok: true, empty: false, model }` — valid JSON parsed into a model.
 *   - `{ ok: true, empty: true,  model: null }` — empty/whitespace-only input,
 *     treated as valid with no model (Req 6.3).
 *   - `{ ok: false, error }` — a syntax error located at a 1-based line/column.
 */
export type ParseResult =
  | { ok: true; empty: false; model: JsonNode }
  | { ok: true; empty: true; model: null }
  | { ok: false; error: ParseErrorInfo };

/** Strict JSON: no comments, no trailing commas, content required. */
const STRICT_JSONC_OPTIONS: ParseOptions = {
  disallowComments: true,
  allowTrailingComma: false,
  allowEmptyContent: false,
};

/**
 * Parse JSON `text` into a `JsonNode` model.
 *
 * Empty or whitespace-only input is valid-empty. Otherwise the strict
 * `lossless-json` parser decides validity; on failure the first error is
 * located via `jsonc-parser`.
 */
export function parseJson(text: string): ParseResult {
  // Empty / whitespace-only input is valid with no model (Req 6.3).
  if (text.trim().length === 0) {
    return { ok: true, empty: true, model: null };
  }

  // Success path: strict, precision-preserving parse.
  try {
    // `lossless-json` is the strict validity gate: it rejects comments,
    // trailing commas, duplicate keys, and malformed tokens by throwing. We
    // only use it to *decide validity* here, not to build the model.
    parseLossless(text);
  } catch (error) {
    // Failure path: locate the first error with a 1-based line/column.
    return { ok: false, error: locateFirstError(text, error) };
  }

  // Build the model from `jsonc-parser`'s concrete syntax tree rather than from
  // `lossless-json`'s value tree. `lossless-json` assembles each object as a
  // plain JS object via `obj[key] = value`, which silently drops object keys
  // that collide with `Object.prototype` accessors (e.g. `__proto__`) before we
  // can observe them. The `jsonc-parser` tree carries members as an ordered
  // array of `property` nodes keyed by string *values*, so every key — however
  // named — survives into the (array-backed, prototype-safe) `JsonNode` model.
  const tree = parseTree(text, [], STRICT_JSONC_OPTIONS);
  if (tree === undefined) {
    // Unreachable for non-empty, lossless-valid input, but guard defensively.
    return { ok: true, empty: true, model: null };
  }
  return { ok: true, empty: false, model: fromJsoncTree(tree as JsoncNode, text) };
}

/**
 * Locate the first syntax error in reading order using `jsonc-parser`'s
 * error-recovering scanner, and translate its offset into a 1-based
 * line/column. Falls back to the position embedded in the `lossless-json`
 * error message, then to the document start, if no structured error is found.
 */
function locateFirstError(text: string, losslessError: unknown): ParseErrorInfo {
  const errors: JsoncParseError[] = [];
  parseTree(text, errors, STRICT_JSONC_OPTIONS);

  const first = firstErrorByOffset(errors);
  if (first) {
    const { line, column } = offsetToLineColumn(text, first.offset);
    const type = errorTypeName(first.error);
    return {
      type,
      line,
      column,
      message: `${humanizeType(type)} at line ${line}, column ${column}`,
    };
  }

  // Fallback: derive the offset from the lossless-json message if possible.
  const fallbackOffset = offsetFromLosslessMessage(losslessError);
  const { line, column } = offsetToLineColumn(text, fallbackOffset);
  const message =
    losslessError instanceof Error && losslessError.message
      ? losslessError.message
      : `Syntax error at line ${line}, column ${column}`;
  return { type: 'SyntaxError', line, column, message };
}

/** Pick the error with the smallest offset (first in reading order). */
function firstErrorByOffset(
  errors: readonly JsoncParseError[],
): JsoncParseError | undefined {
  let first: JsoncParseError | undefined;
  for (const candidate of errors) {
    if (first === undefined || candidate.offset < first.offset) {
      first = candidate;
    }
  }
  return first;
}

/** Map a `jsonc-parser` error code to its enum name (e.g. `"ColonExpected"`). */
function errorTypeName(code: number): string {
  const printed = printParseErrorCode(code);
  return printed.length > 0 ? printed : 'SyntaxError';
}

/** Turn a PascalCase error name into a readable phrase. */
function humanizeType(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Convert a 0-based character offset into a 1-based line and column.
 * An offset past the end of the text clamps to the end.
 */
function offsetToLineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * Best-effort extraction of a 0-based offset from a `lossless-json`
 * `SyntaxError` message of the form "... at position N". Returns 0 when no
 * position is present.
 */
function offsetFromLosslessMessage(error: unknown): number {
  if (error instanceof Error) {
    const match = /position (\d+)/.exec(error.message);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return 0;
}
