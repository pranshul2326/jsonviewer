// Feature: json-viewer-free
//
// Expression query engine (Req 16): evaluates JSONPath and JMESPath
// expressions against the current JSON document and returns a typed,
// discriminated result.
//
// Design (see design.md "Components and Interfaces" → `query/engine.ts`, and
// Req 16.1–16.4, 16.6):
//   - JSONPath is evaluated with `jsonpath-plus`. SECURITY: jsonpath-plus
//     versions < 10.0.0 carry an RCE advisory (CVE-2024-21534) because path
//     "script" expressions (filters/`()`) could execute arbitrary JavaScript
//     via `eval`/`Function`. We pin >=10.3.0 AND pass `eval: false`, which
//     disables JavaScript execution inside path strings entirely, so no path
//     can run arbitrary code. (The old equivalent was `preventEval: true`.)
//   - JMESPath is evaluated with the reference `jmespath` implementation.
//     `jmespath.compile` parses the expression and throws on a syntax error,
//     letting us surface a typed error before evaluating; `jmespath.search`
//     performs the evaluation. JMESPath has no scripting/`eval` facility, so
//     there is no analogous code-execution surface to disable.
//
// The engine is pure and framework-free: it takes the document as text, parses
// it once with `JSON.parse`, and evaluates the expression against the parsed
// value. Reporting "no results" vs. results is the panel's concern (Req 16.4);
// the engine simply returns the matches (an empty list on no match).

import { JSONPath } from 'jsonpath-plus';
import { search, compile as compileJmespath } from 'jmespath';

// `@types/jmespath` only declares `search`. `compile` exists at runtime and is
// used here purely to validate/parse the expression (it throws on a syntax
// error). Augment the module with a narrow declaration to keep type-safety.
declare module 'jmespath' {
  /** Parse a JMESPath expression, throwing on a syntax error. */
  export function compile(expression: string): unknown;
}

/** The two supported query languages. */
export type QueryMode = 'jsonpath' | 'jmespath';

/**
 * A query failure (Req 16.3, 16.6): a human-readable description of the
 * problem and, where determinable, the 0-based character position within the
 * expression at which the syntax problem occurs.
 */
export interface QueryError {
  /** Human-readable explanation of the failure. */
  message: string;
  /** 0-based character position of the syntax problem, where determinable. */
  position?: number;
}

/**
 * The outcome of evaluating a query.
 *
 *   - `{ ok: true, results }` — the matching results. An empty array means the
 *     evaluation succeeded with zero matches (the no-results indicator is the
 *     panel's concern, Req 16.4).
 *   - `{ ok: false, error }` — an invalid/empty expression or invalid document;
 *     the caller leaves previously displayed results unchanged (Req 16.3, 16.6).
 */
export type QueryResult =
  | { ok: true; results: unknown[] }
  | { ok: false; error: QueryError };

/**
 * Evaluate `expression` (in the selected `mode`) against the JSON document in
 * `jsonText` and return the matching results.
 *
 * Guards, in order:
 *   1. Empty/whitespace-only expression → error "an expression is required"
 *      (Req 16.6).
 *   2. Invalid JSON document → error describing the document problem.
 *   3. Syntactically invalid expression → error with the nature and, where
 *      available, the character position of the problem (Req 16.3).
 */
export function runQuery(
  jsonText: string,
  expression: string,
  mode: QueryMode,
): QueryResult {
  // (1) Empty-expression guard (Req 16.6).
  if (expression.trim().length === 0) {
    return {
      ok: false,
      error: { message: 'An expression is required.' },
    };
  }

  // (2) Parse the document to query. `JSON.parse` yields a plain JS value that
  // both engines understand directly.
  let document: unknown;
  try {
    document = JSON.parse(jsonText);
  } catch (error) {
    return {
      ok: false,
      error: {
        message:
          error instanceof Error
            ? `The document is not valid JSON: ${error.message}`
            : 'The document is not valid JSON.',
      },
    };
  }

  // (3) Evaluate per mode.
  return mode === 'jsonpath'
    ? runJsonPath(document, expression)
    : runJmesPath(document, expression);
}

/**
 * Evaluate a JSONPath expression with script evaluation disabled.
 *
 * `eval: false` forbids any JavaScript execution inside the path (the
 * CVE-2024-21534 mitigation). `wrap: true` makes the result a plain array of
 * matched values, one element per match (empty when nothing matches).
 */
function runJsonPath(document: unknown, expression: string): QueryResult {
  try {
    const results = JSONPath({
      path: expression,
      json: document as object,
      // SECURITY: disable JavaScript execution in path strings (CVE-2024-21534).
      eval: false,
      // Always return an array of matched values (empty array on no match).
      wrap: true,
      resultType: 'value',
    }) as unknown[];

    return { ok: true, results: Array.isArray(results) ? results : [] };
  } catch (error) {
    return { ok: false, error: toQueryError(error, expression) };
  }
}

/**
 * Evaluate a JMESPath expression.
 *
 * `compile` is called first so a syntax error is reported before evaluation
 * (Req 16.3). `search` then returns the single transformed document; a `null`
 * (or `undefined`) result represents "no match" and maps to an empty result
 * list, while any other value is returned as a single result.
 */
function runJmesPath(document: unknown, expression: string): QueryResult {
  // Validate/parse first so syntax problems are reported distinctly (Req 16.3).
  try {
    compileJmespath(expression);
  } catch (error) {
    return { ok: false, error: toQueryError(error, expression) };
  }

  try {
    const result = search(document, expression);
    if (result === null || result === undefined) {
      return { ok: true, results: [] };
    }
    return { ok: true, results: [result] };
  } catch (error) {
    return { ok: false, error: toQueryError(error, expression) };
  }
}

/**
 * Translate a thrown engine error into a typed `QueryError`, extracting a
 * 0-based character position from the message when the engine embeds one.
 */
function toQueryError(error: unknown, expression: string): QueryError {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'The expression is not valid for the selected mode.';
  const position = extractPosition(error, expression);
  return position === undefined ? { message } : { message, position };
}

/**
 * Best-effort extraction of a 0-based character position from an engine error
 * message (e.g. "...at position 12", "...char 3"). Returns `undefined` when no
 * position can be determined, in which case the caller omits it (Req 16.3
 * "where available").
 */
function extractPosition(error: unknown, expression: string): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const match = /(?:position|char(?:acter)?|index|column|offset)\s*:?\s*(\d+)/i.exec(
    error.message,
  );
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  if (Number.isNaN(value) || value < 0 || value > expression.length) {
    return undefined;
  }
  return value;
}
