// Feature: json-viewer-free
//
// Tests for the expression query engine in `engine.ts` (Req 16).
//
//   - Property 29: Query evaluation returns the targeted nodes
//                  (Req 16.1, 16.2) — for a generated document and an
//                  expression (JSONPath or JMESPath) that targets a known
//                  node, evaluation returns exactly that node's value.
//   - Unit tests for the invalid-expression error path (Req 16.3): a
//     syntactically invalid expression yields a typed syntax error, with a
//     0-based character position where the engine can determine one.
//   - Unit tests for the empty-expression guard (Req 16.6): an empty or
//     whitespace-only expression yields the "expression is required" error.
//
// The property test builds, for a randomly chosen path into the generated
// document, the equivalent JSONPath and JMESPath expressions, then checks the
// evaluation result against an oracle that re-navigates the *same* parsed
// document (never by calling the engine), so the check is independent.

import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import { runQuery } from './engine';
import { edgyStringArbitrary, numberLexemeArbitrary } from '../../test/arbitraries';

// ─── Document + path generators ──────────────────────────────────────────────
//
// We generate a plain JS JSON value (the document) with object keys constrained
// to safe identifiers, so the equivalent path expression can be built reliably
// in both query languages. Leaf VALUES still draw from the shared edge-y string
// and full numeric-lexeme arbitraries, so the value space stays rich.

/** A path step: into an object by key, or into an array by index. */
type PathStep = { kind: 'key'; key: string } | { kind: 'index'; index: number };
type Path = PathStep[];

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_'.split('');

/** A safe object-key identifier: a letter followed by alphanumerics/underscore. */
const safeKeyArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...LETTERS),
    fc.array(fc.constantFrom(...KEY_CHARS), { maxLength: 5 }),
  )
  .map(([head, tail]) => head + tail.join(''));

/** A scalar leaf value: edge-y string, boolean, finite number, or null. */
const leafArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  edgyStringArbitrary(),
  fc.boolean(),
  numberLexemeArbitrary().map(Number).filter(Number.isFinite),
  fc.constant(null),
);

/** A recursive JSON value with bounded depth/breadth and safe object keys. */
const jsonValueArbitrary: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>(
  (tie) => ({
    value: fc.oneof(
      { maxDepth: 3, depthIdentifier: 'qjson' },
      leafArbitrary,
      fc.array(tie('value'), { maxLength: 4 }),
      fc
        .uniqueArray(fc.tuple(safeKeyArbitrary, tie('value')), {
          selector: (entry) => entry[0],
          maxLength: 4,
        })
        .map((entries) => Object.fromEntries(entries)),
    ),
  }),
).value;

/** Enumerate the paths to every non-null node (including the root). */
function nonNullPaths(value: unknown, prefix: Path = []): Path[] {
  const out: Path[] = value === null ? [] : [prefix];
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      out.push(...nonNullPaths(item, [...prefix, { kind: 'index', index }])),
    );
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out.push(
        ...nonNullPaths((value as Record<string, unknown>)[key], [
          ...prefix,
          { kind: 'key', key },
        ]),
      );
    }
  }
  return out;
}

/** Navigate a path into a value to obtain the targeted node's value. */
function navigate(value: unknown, path: Path): unknown {
  let current: unknown = value;
  for (const step of path) {
    current =
      step.kind === 'index'
        ? (current as unknown[])[step.index]
        : (current as Record<string, unknown>)[step.key];
  }
  return current;
}

/** Build the equivalent JSONPath expression for a path (bracket notation). */
function toJsonPath(path: Path): string {
  let expr = '$';
  for (const step of path) {
    expr +=
      step.kind === 'index' ? `[${step.index}]` : `[${JSON.stringify(step.key)}]`;
  }
  return expr;
}

/** Build the equivalent JMESPath expression for a path (quoted identifiers). */
function toJmesPath(path: Path): string {
  if (path.length === 0) {
    return '@'; // the current/root node
  }
  let expr = '';
  let first = true;
  for (const step of path) {
    if (step.kind === 'index') {
      expr += `[${step.index}]`;
    } else {
      const identifier = `"${step.key}"`;
      expr += first ? identifier : `.${identifier}`;
    }
    first = false;
  }
  return expr;
}

/**
 * A document whose root is a container (object or array). JSONPath's `$` and
 * JMESPath's `@` address a top-level scalar inconsistently across the two
 * languages (JSONPath treats `$` as matching only object/array roots), so we
 * exercise node-targeting against realistic container-rooted documents; scalar
 * leaves still appear richly at every nested position.
 */
const containerRootArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  fc.array(jsonValueArbitrary, { maxLength: 4 }),
  fc
    .uniqueArray(fc.tuple(safeKeyArbitrary, jsonValueArbitrary), {
      selector: (entry) => entry[0],
      maxLength: 4,
    })
    .map((entries) => Object.fromEntries(entries)),
);

/** A generated document together with a path to one of its non-null nodes. */
const documentWithTargetArbitrary = containerRootArbitrary
  .map((document) => ({ document, paths: nonNullPaths(document) }))
  .filter(({ paths }) => paths.length > 0)
  .chain(({ document, paths }) =>
    fc.constantFrom(...paths).map((path) => ({ document, path })),
  );

// ─── Property 29 ─────────────────────────────────────────────────────────────

describe('Property 29: Query evaluation returns the targeted nodes (Req 16.1, 16.2)', () => {
  // Feature: json-viewer-free, Property 29: Query evaluation returns the targeted nodes
  // Validates: Requirements 16.1, 16.2
  test.prop([documentWithTargetArbitrary], { numRuns: 100 })(
    'JSONPath and JMESPath expressions for a known path each return exactly that node',
    ({ document, path }) => {
      const jsonText = JSON.stringify(document);
      // Oracle: derive the expected node by re-parsing the same text and
      // walking the path — independent of the engine.
      const expected = navigate(JSON.parse(jsonText), path);

      const viaJsonPath = runQuery(jsonText, toJsonPath(path), 'jsonpath');
      expect(viaJsonPath.ok).toBe(true);
      if (viaJsonPath.ok) {
        expect(viaJsonPath.results).toEqual([expected]);
      }

      const viaJmesPath = runQuery(jsonText, toJmesPath(path), 'jmespath');
      expect(viaJmesPath.ok).toBe(true);
      if (viaJmesPath.ok) {
        expect(viaJmesPath.results).toEqual([expected]);
      }
    },
  );
});

// ─── Unit tests: invalid-expression error path (Req 16.3) ────────────────────

describe('Invalid expressions return a typed syntax error (Req 16.3)', () => {
  const doc = '{"a":[{"b":1}],"c":2}';

  it('reports a JMESPath syntax error with a character position when available', () => {
    // An unterminated quoted identifier; the engine surfaces a syntax error
    // carrying the 0-based character position of the problem.
    const expression = '"unterminated';
    const result = runQuery(doc, expression, 'jmespath');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.message).toBe('string');
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.position).toBe(13);
      // The position is a valid index within the expression.
      expect(result.error.position).toBeLessThanOrEqual(expression.length);
    }
  });

  it('reports a JMESPath syntax error even when no position is determinable', () => {
    const result = runQuery(doc, 'foo[', 'jmespath');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.position).toBeUndefined();
    }
  });

  it('reports a JSONPath syntax error and leaves no results', () => {
    const result = runQuery(doc, '@@', 'jsonpath');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.message).toBe('string');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects a JSONPath script expression (eval disabled) as invalid', () => {
    // With JavaScript evaluation disabled (CVE-2024-21534 mitigation), a path
    // "script"/filter expression is reported as an error rather than executed.
    const result = runQuery(doc, '$.a[?(@.b)]', 'jsonpath');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

// ─── Unit tests: empty-expression guard (Req 16.6) ───────────────────────────

describe('Empty expressions hit the empty-expression guard (Req 16.6)', () => {
  const doc = '{"a":1}';

  it('rejects an empty expression in JSONPath mode', () => {
    const result = runQuery(doc, '', 'jsonpath');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('An expression is required.');
      expect(result.error.position).toBeUndefined();
    }
  });

  it('rejects an empty expression in JMESPath mode', () => {
    const result = runQuery(doc, '', 'jmespath');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('An expression is required.');
    }
  });

  it('rejects a whitespace-only expression (guard runs before parsing)', () => {
    const result = runQuery(doc, '   \t\n', 'jsonpath');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('An expression is required.');
    }
  });
});
