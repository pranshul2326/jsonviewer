// Feature: json-viewer-free
//
// `smartFix` — a one-click repair for the three common, mechanically
// correctable JSON mistakes (Req 7):
//
//   1. Trailing commas before a closing `}` or `]`            (Req 7.1)
//   2. Unquoted object keys -> wrapped in double quotes        (Req 7.2)
//   3. Single-quote string delimiters -> double quotes         (Req 7.3)
//
// All three categories are repaired in a single activation (Req 7.4): one
// left-to-right pass rewrites the text while counting corrections per category
// (Req 7.6). The pass is *string-literal aware* — a comma, brace, or bareword
// that lives inside a string value is copied verbatim so that string contents
// are never corrupted.
//
// The rewritten text is then validated with `parseJson` (the same Validator the
// rest of the app uses). On success we return the corrected text plus the
// per-category summary, and the result is guaranteed valid (Req 7.5, 7.8). On
// failure we return the first remaining error's 1-based line and column so the
// caller can leave the editor untouched and report the location (Req 7.7).

import { parseJson } from './parse';

/** Per-category counts of the corrections applied in a single activation (Req 7.6). */
export interface FixSummary {
  /** Number of trailing commas removed before a `}` or `]` (Req 7.1). */
  trailingCommas: number;
  /** Number of unquoted object keys wrapped in double quotes (Req 7.2). */
  unquotedKeys: number;
  /** Number of single-quoted strings re-delimited with double quotes (Req 7.3). */
  singleQuotes: number;
}

/**
 * The outcome of a Smart Fixer activation.
 *
 *   - `{ ok: true, text, summary }` — the corrected, valid JSON text together
 *     with the per-category correction counts. `text` is guaranteed to parse
 *     (Req 7.8); all-zero counts mean no corrections were needed (Req 7.6).
 *   - `{ ok: false, line, column, message }` — the rewritten text still does not
 *     parse; `line`/`column` locate the first remaining error (1-based, Req 7.7).
 */
export type FixResult =
  | { ok: true; text: string; summary: FixSummary }
  | { ok: false; line: number; column: number; message: string };

/** Alias matching the spec's narrative name for the discriminated union. */
export type SmartFixResult = FixResult;

/**
 * Repair the three correctable categories of malformed JSON in `text`,
 * returning the corrected valid JSON with a per-category summary, or the first
 * remaining error location when a valid document cannot be produced.
 */
export function smartFix(text: string): FixResult {
  const { output, summary } = rewrite(text);

  // The corrected text is only accepted when the Validator confirms it is valid
  // JSON (Req 7.8). Empty / whitespace-only input is valid-empty (no model).
  const parsed = parseJson(output);
  if (parsed.ok) {
    return { ok: true, text: output, summary };
  }

  // Could not produce valid JSON: surface the first remaining error (Req 7.7).
  return {
    ok: false,
    line: parsed.error.line,
    column: parsed.error.column,
    message: parsed.error.message,
  };
}

/**
 * A single left-to-right, string-literal-aware pass that rewrites the source
 * text and counts the corrections made in each category.
 */
function rewrite(text: string): { output: string; summary: FixSummary } {
  const summary: FixSummary = {
    trailingCommas: 0,
    unquotedKeys: 0,
    singleQuotes: 0,
  };

  const out: string[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];

    // A double-quoted string is already well-formed: copy it verbatim
    // (including escapes) so its contents are never reinterpreted.
    if (c === '"') {
      const end = scanDoubleQuoted(text, i);
      out.push(text.slice(i, end));
      i = end;
      continue;
    }

    // A single-quoted string is re-delimited with double quotes, re-escaping
    // interior double quotes and dropping the now-unneeded `\'` escapes (Req 7.3).
    if (c === "'") {
      const { value, next } = convertSingleQuoted(text, i);
      out.push(value);
      summary.singleQuotes += 1;
      i = next;
      continue;
    }

    // A comma immediately preceding a `}` or `]` (ignoring whitespace) is a
    // trailing comma and is removed (Req 7.1).
    if (c === ',') {
      const j = skipWhitespace(text, i + 1);
      if (j < n && (text[j] === '}' || text[j] === ']')) {
        summary.trailingCommas += 1;
        i += 1; // drop the comma
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }

    // An identifier start: could be a JSON literal (true/false/null), or an
    // unquoted object key (an identifier followed by `:`), which we wrap in
    // double quotes (Req 7.2). Anything else is emitted unchanged.
    if (isIdentifierStart(c)) {
      const end = scanIdentifier(text, i);
      const word = text.slice(i, end);

      if (word === 'true' || word === 'false' || word === 'null') {
        out.push(word);
        i = end;
        continue;
      }

      const afterWord = skipWhitespace(text, end);
      if (afterWord < n && text[afterWord] === ':') {
        out.push('"', word, '"');
        summary.unquotedKeys += 1;
        i = end;
        continue;
      }

      // Bareword that is not a literal and not a key — out of the correctable
      // categories. Emit as-is; the validator will report it if it is invalid.
      out.push(word);
      i = end;
      continue;
    }

    // Structural characters, numbers, whitespace, colons, etc.: copy verbatim.
    out.push(c);
    i += 1;
  }

  return { output: out.join(''), summary };
}

/**
 * Return the index just past a double-quoted string that starts at `start`
 * (where `text[start] === '"'`), honoring backslash escapes. If the string is
 * unterminated, returns the end of the text.
 */
function scanDoubleQuoted(text: string, start: number): number {
  const n = text.length;
  let i = start + 1;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      i += 2; // skip the escaped character
      continue;
    }
    if (c === '"') {
      return i + 1;
    }
    i += 1;
  }
  return n;
}

/**
 * Convert a single-quoted string that starts at `start` (where
 * `text[start] === "'"`) into an equivalent double-quoted string. Interior
 * unescaped double quotes are escaped, and `\'` escapes are reduced to a bare
 * `'`. Other JSON escape sequences are preserved verbatim.
 *
 * Returns the converted double-quoted text and the index just past the source
 * string (the end of the text if the string is unterminated).
 */
function convertSingleQuoted(
  text: string,
  start: number,
): { value: string; next: number } {
  const n = text.length;
  const body: string[] = [];
  let i = start + 1;

  while (i < n) {
    const c = text[i];

    if (c === '\\') {
      const escaped = i + 1 < n ? text[i + 1] : '';
      if (escaped === "'") {
        // `\'` is unnecessary inside a double-quoted string.
        body.push("'");
      } else {
        // Preserve any other escape sequence (\" \\ \/ \n \uXXXX, ...).
        body.push('\\', escaped);
      }
      i += 2;
      continue;
    }

    if (c === "'") {
      // Closing delimiter.
      return { value: `"${body.join('')}"`, next: i + 1 };
    }

    if (c === '"') {
      // A bare double quote must be escaped in the double-quoted form.
      body.push('\\"');
      i += 1;
      continue;
    }

    body.push(c);
    i += 1;
  }

  // Unterminated single-quoted string: emit what we have (validation will fail).
  return { value: `"${body.join('')}`, next: n };
}

/** Return the first index at or after `start` that is not JSON whitespace. */
function skipWhitespace(text: string, start: number): number {
  const n = text.length;
  let i = start;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

/** Return the index just past an identifier that starts at `start`. */
function scanIdentifier(text: string, start: number): number {
  const n = text.length;
  let i = start;
  while (i < n && isIdentifierPart(text[i])) {
    i += 1;
  }
  return i;
}

/** A character that may begin a bareword identifier (letter, `_`, or `$`). */
function isIdentifierStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}

/** A character that may continue a bareword identifier. */
function isIdentifierPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}
