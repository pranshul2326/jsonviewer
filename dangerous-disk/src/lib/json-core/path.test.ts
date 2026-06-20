// Feature: json-viewer-free
//
// Property-based tests for JSON path computation (`path.ts`):
//   - Property 8: Path-correctness for both notations (Req 4.1, 4.2, 4.6)
//   - Property 9: Dot-path key escaping rule (Req 4.5)
//
// Both properties draw their inputs from the shared arbitraries in
// `src/test/arbitraries.ts` and verify the *round-trip* relationship the design
// demands: a path produced by `dotPath`/`bracketPath` must, when fed back to
// `resolvePath`, resolve to exactly the node it was computed for.

import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from './types';
import { dotPath, bracketPath, resolvePath } from './path';
import {
  jsonArbitrary,
  scalarJsonArbitrary,
  edgyStringArbitrary,
} from '../../test/arbitraries';

/** Every node in the tree, in pre-order (root first). */
function collectNodes(root: JsonNode): JsonNode[] {
  const out: JsonNode[] = [root];
  if (root.children) {
    for (const child of root.children) {
      out.push(...collectNodes(child));
    }
  }
  return out;
}

/**
 * The expected dot-notation safe-identifier predicate (Req 4.5), written
 * independently of the implementation so the test does not merely restate it:
 * a key is dot-renderable iff it is non-empty, contains only ASCII letters,
 * digits, and underscore, and does not begin with a digit.
 */
function expectedSafeIdentifier(key: string): boolean {
  if (key.length === 0) return false;
  const first = key.charCodeAt(0);
  const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
  const isLetter = (c: number) =>
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  const isUnderscore = (c: number) => c === 0x5f;
  if (!(isLetter(first) || isUnderscore(first))) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!(isLetter(c) || isDigit(c) || isUnderscore(c))) return false;
  }
  return true;
}

/** Build a single-key object model whose one child carries `key` and `value`. */
function singleKeyModel(key: string, value: JsonNode): JsonNode {
  return {
    id: '$',
    key: null,
    type: 'object',
    children: [{ ...value, id: '$/child', key }],
  };
}

/**
 * Keys spanning both branches of the escaping rule: guaranteed-safe
 * identifiers, the full edge-y string space (unicode, quotes, escapes,
 * whitespace, empty), and explicit unsafe shapes (digit-leading, punctuation).
 */
const safeIdentifierArbitrary = fc
  .tuple(
    fc.constantFrom(...'ABCDEFghijkl_'.split('')),
    fc.array(fc.constantFrom(...'AZaz09_'.split('')), { maxLength: 10 }),
  )
  .map(([first, rest]) => first + rest.join(''));

const keyArbitrary = fc.oneof(
  safeIdentifierArbitrary,
  edgyStringArbitrary(),
  fc.fullUnicodeString(),
  fc.constantFrom(
    '',
    '0',
    '123',
    '1abc',
    'a b',
    'a-b',
    'a.b',
    'a[0]',
    'a"b',
    "a'b",
    'a\\b',
    '$ref',
    'key with spaces',
    'naïve',
  ),
);

describe('Property 8: Path-correctness for both notations (Req 4.1, 4.2, 4.6)', () => {
  // For any model and any node within it, the computed dot-notation and
  // bracket-notation paths each resolve back to exactly that node.
  test.prop([jsonArbitrary(), fc.nat()], { numRuns: 100 })(
    'dotPath and bracketPath both resolve to the originating node',
    (model, rawIndex) => {
      const nodes = collectNodes(model);
      const node = nodes[rawIndex % nodes.length];

      const dot = dotPath(model, node.id);
      const bracket = bracketPath(model, node.id);

      const viaDot = resolvePath(model, dot);
      const viaBracket = resolvePath(model, bracket);

      if (viaDot !== node) {
        throw new Error(
          `dot path ${JSON.stringify(dot)} resolved to a different node` +
            ` (expected id ${node.id}, got ${viaDot?.id ?? 'undefined'})`,
        );
      }
      if (viaBracket !== node) {
        throw new Error(
          `bracket path ${JSON.stringify(bracket)} resolved to a different node` +
            ` (expected id ${node.id}, got ${viaBracket?.id ?? 'undefined'})`,
        );
      }
      return true;
    },
  );
});

describe('Property 9: Dot-path key escaping rule (Req 4.5)', () => {
  // For any object key, the single-segment dot path renders the key bare when
  // it is a safe identifier and as a bracketed quoted segment otherwise; in
  // both cases the path still resolves to the node.
  test.prop([keyArbitrary, scalarJsonArbitrary()], { numRuns: 100 })(
    'a key renders dot-prefixed iff safe, bracketed-quoted otherwise, and resolves',
    (key, value) => {
      const model = singleKeyModel(key, value);
      const child = model.children![0];

      const dot = dotPath(model, child.id);

      if (expectedSafeIdentifier(key)) {
        // First (and only) segment: a safe identifier is emitted bare.
        expect(dot).toBe(key);
      } else {
        // Unsafe or empty key: a bracketed, double-quoted, JSON-escaped segment.
        expect(dot).toBe(`[${JSON.stringify(key)}]`);
      }

      // In both branches the rendered dot path resolves to exactly the node.
      expect(resolvePath(model, dot)).toBe(child);
      return true;
    },
  );

  it('renders a known safe key bare and an unsafe key bracketed', () => {
    const safe = singleKeyModel('userName_1', { id: 'x', key: null, type: 'null' });
    expect(dotPath(safe, safe.children![0].id)).toBe('userName_1');

    const unsafe = singleKeyModel('first name', { id: 'x', key: null, type: 'null' });
    expect(dotPath(unsafe, unsafe.children![0].id)).toBe('["first name"]');
  });
});
