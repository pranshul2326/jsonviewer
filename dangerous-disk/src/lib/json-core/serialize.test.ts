// Feature: json-viewer-free
//
// Property-based tests for the text emitters in `serialize.ts` (format /
// serialize / minify) together with `parseJson` and the `structuralEquals`
// oracle. Three design properties are covered:
//
//   Property 1: Parse/serialize round-trip preserves the model.
//   Property 2: Format and minify round-trips preserve the model.
//   Property 3: Formatting produces correct indentation structure (and minify
//               strips only out-of-string whitespace).
//
// All inputs are drawn from the shared arbitraries in `src/test/arbitraries.ts`
// so the generators stay biased toward the edge cases the properties care about
// (deep nesting, edge-y strings, big/high-precision numbers).

import { describe } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { format, minify, serialize, type IndentStyle } from './serialize';
import { parseJson } from './parse';
import type { JsonNode } from './types';
import { jsonArbitrary, structuralEquals } from '../../test/arbitraries';

// At least 100 iterations per property (design requirement).
const RUNS = { numRuns: 100 } as const;

/** The three supported indentation styles (Req 5.1, 5.2, 5.3). */
const STYLES: readonly IndentStyle[] = [
  { kind: 'space', size: 2 },
  { kind: 'space', size: 4 },
  { kind: 'tab' },
];

/** The per-depth indentation unit a style produces. */
function unitFor(style: IndentStyle): string {
  return style.kind === 'tab' ? '\t' : ' '.repeat(style.size);
}

/**
 * Parse JSON text and return the model, failing loudly if the text was not
 * parsed into a (non-empty) model. Serialized/formatted/minified output of any
 * generated model is always non-empty valid JSON, so the empty/error branches
 * here indicate a genuine emitter defect.
 */
function parseToModel(text: string): JsonNode {
  const result = parseJson(text);
  if (!result.ok) {
    throw new Error(
      `expected valid JSON but parse failed: ${result.error.message}\n--- text ---\n${text}`,
    );
  }
  if (result.empty) {
    throw new Error(`expected a model but parse reported empty\n--- text ---\n${text}`);
  }
  return result.model;
}

// ---------------------------------------------------------------------------
// Independent scanners used by Property 3 (deliberately NOT reusing the
// emitter's own logic, so a shared bug cannot mask a failure).
// ---------------------------------------------------------------------------

const JSON_WS = new Set([' ', '\t', '\n', '\r']);

/**
 * Verify that every physical line of formatted `text` is indented by exactly
 * `depth` repetitions of `unit`, where `depth` is the structural nesting depth
 * tracked by counting brackets outside string literals. A line whose first
 * non-whitespace character is a closing bracket belongs to its container's
 * depth (one less than the inner depth). Returns an error message, or null.
 *
 * Formatted output never contains real newlines inside string literals (control
 * characters are escaped), so splitting on `\n` is safe.
 */
function checkIndentation(text: string, unit: string): string | null {
  const lines = text.split('\n');
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const leading = /^[ \t]*/.exec(line)![0];
    const rest = line.slice(leading.length);
    const firstChar = rest[0];
    const startsWithCloser = firstChar === '}' || firstChar === ']';
    const expectedDepth = Math.max(0, depth - (startsWithCloser ? 1 : 0));
    const expectedIndent = unit.repeat(expectedDepth);

    // Only meaningful for lines that actually have content (the emitter never
    // produces blank structural lines).
    if (rest.length > 0 && leading !== expectedIndent) {
      return `line ${li + 1}: indent ${JSON.stringify(leading)} !== expected ${JSON.stringify(
        expectedIndent,
      )} (depth ${expectedDepth})\n--- text ---\n${text}`;
    }

    // Advance depth/string state across this line's structural characters.
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
    }
  }
  return null;
}

/**
 * Verify that every structural name-value separator (`:` outside a string) is
 * followed by exactly one space character (Req 5.1–5.3). Returns an error
 * message, or null.
 */
function checkColonSpacing(text: string): string | null {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ':') {
      if (text[i + 1] !== ' ') {
        return `colon at index ${i} not followed by a space\n--- text ---\n${text}`;
      }
      if (text[i + 2] === ' ') {
        return `colon at index ${i} followed by more than one space\n--- text ---\n${text}`;
      }
    }
  }
  return null;
}

/** Return the raw string-literal tokens (quotes included) of `text`, in order. */
function stringLiterals(text: string): string[] {
  const tokens: string[] = [];
  let inString = false;
  let escaped = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        tokens.push(current);
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      current = '"';
    }
  }
  return tokens;
}

/** Verify `minified` has no whitespace outside string literals. */
function checkNoOutOfStringWhitespace(minified: string): string | null {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < minified.length; i++) {
    const ch = minified[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (JSON_WS.has(ch)) {
      return `whitespace ${JSON.stringify(ch)} found outside a string at index ${i}\n--- minified ---\n${minified}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('serialize / format / minify round-trips and structure', () => {
  // Feature: json-viewer-free, Property 1: Parse/serialize round-trip preserves
  // the model. Validates: Requirements 2.8, 5.5
  test.prop([jsonArbitrary()], RUNS)(
    'Property 1: serialize then parse yields a structurally equivalent model',
    (model) => {
      const text = serialize(model);
      const reparsed = parseToModel(text);
      if (!structuralEquals(model, reparsed)) {
        throw new Error(
          `round-trip changed the model\n--- serialized ---\n${text}`,
        );
      }
      return true;
    },
  );

  // Feature: json-viewer-free, Property 2: Format and minify round-trips
  // preserve the model. Validates: Requirements 5.5, 5.6
  test.prop([jsonArbitrary(), fc.constantFrom(...STYLES)], RUNS)(
    'Property 2: parsing formatted and minified output equals parsing the original',
    (model, style) => {
      const originalText = serialize(model);
      const originalModel = parseToModel(originalText);

      // Formatting round-trip (Req 5.5).
      const formatted = format(model, style);
      const fromFormatted = parseToModel(formatted);
      if (!structuralEquals(originalModel, fromFormatted)) {
        throw new Error(
          `format round-trip changed the model (style ${JSON.stringify(
            style,
          )})\n--- formatted ---\n${formatted}`,
        );
      }

      // Minification round-trip (Req 5.6) — minify the formatted text so its
      // out-of-string whitespace is what gets removed.
      const minified = minify(formatted);
      const fromMinified = parseToModel(minified);
      if (!structuralEquals(originalModel, fromMinified)) {
        throw new Error(
          `minify round-trip changed the model\n--- minified ---\n${minified}`,
        );
      }
      return true;
    },
  );

  // Feature: json-viewer-free, Property 3: Formatting produces correct
  // indentation structure; minify strips only out-of-string whitespace and
  // preserves in-string whitespace. Validates: Requirements 5.1, 5.2, 5.3, 5.4
  test.prop([jsonArbitrary(), fc.constantFrom(...STYLES)], RUNS)(
    'Property 3: formatting indents one unit per depth and minify is string-aware',
    (model, style) => {
      const unit = unitFor(style);
      const formatted = format(model, style);

      const indentError = checkIndentation(formatted, unit);
      if (indentError) throw new Error(`indentation: ${indentError}`);

      const colonError = checkColonSpacing(formatted);
      if (colonError) throw new Error(`colon spacing: ${colonError}`);

      // Minify the formatted text: no whitespace may remain outside string
      // literals, and every string literal (with its interior whitespace) must
      // be preserved exactly and in order (Req 5.4).
      const minified = minify(formatted);

      const wsError = checkNoOutOfStringWhitespace(minified);
      if (wsError) throw new Error(`minify whitespace: ${wsError}`);

      const before = stringLiterals(formatted);
      const after = stringLiterals(minified);
      if (before.length !== after.length) {
        throw new Error(
          `minify changed the number of string literals: ${before.length} -> ${after.length}\n--- minified ---\n${minified}`,
        );
      }
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== after[i]) {
          throw new Error(
            `minify altered string literal #${i}: ${JSON.stringify(
              before[i],
            )} -> ${JSON.stringify(after[i])}`,
          );
        }
      }
      return true;
    },
  );
});
