// Feature: json-viewer-free
//
// Property-based tests for the three-way merge (`merge.ts`):
//   - Property 20: Three-way merge applies all non-conflicting changes
//     (Req 11.1, 11.2, 11.3, 11.4)
//   - Property 21: Three-way merge detects and resolves conflicts
//     (Req 11.5, 11.6)
//
// All documents are drawn from the shared arbitraries in
// `src/test/arbitraries.ts` and every equivalence check is decided by the
// single oracle `structuralEquals` from `canonical.ts`. The tests build their
// Base/Left/Right scenarios independently of `merge.ts`'s internals: changes
// are applied to chosen scalar leaves and the expected merged document is
// assembled by the test itself, so the assertions never restate the merge's
// own classification logic.

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from './types';
import { threeWayMerge, resolveConflict, type ConflictSide } from './merge';
import {
  jsonArbitrary,
  scalarJsonArbitrary,
  structuralEquals,
} from '../../test/arbitraries';

// ---------------------------------------------------------------------------
// Local helpers (written independently of `merge.ts`)
// ---------------------------------------------------------------------------

/** Deep-clone a `JsonNode` subtree (scalar carriers + ordered children). */
function cloneNode(node: JsonNode): JsonNode {
  return {
    ...node,
    children: node.children?.map(cloneNode),
  };
}

/** RFC 6901 reference-token escaping: `~` -> `~0`, `/` -> `~1` (order matters). */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** RFC 6901 reference-token unescaping: `~1` -> `/`, `~0` -> `~` (order matters). */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append a key/index to a JSON Pointer (the root pointer is `""`). */
function appendPointer(pointer: string, key: string | number): string {
  return `${pointer}/${escapeToken(String(key))}`;
}

/** Resolve an RFC 6901 JSON Pointer against a `JsonNode` model. */
function resolvePointer(root: JsonNode, pointer: string): JsonNode | undefined {
  if (pointer === '') return root;
  const tokens = pointer.split('/').slice(1).map(unescapeToken);
  let current: JsonNode | undefined = root;
  for (const token of tokens) {
    const children: JsonNode[] | undefined = current?.children;
    if (!children) return undefined;
    current = children.find((child) => String(child.key) === token);
    if (current === undefined) return undefined;
  }
  return current;
}

/** True for the four scalar (leaf) JSON types. */
function isScalar(node: JsonNode): boolean {
  return (
    node.type === 'null' ||
    node.type === 'boolean' ||
    node.type === 'string' ||
    node.type === 'number'
  );
}

/** The JSON Pointers of every scalar leaf in `root`, in pre-order. */
function scalarLeafPointers(root: JsonNode): string[] {
  const out: string[] = [];
  const recurse = (node: JsonNode, pointer: string): void => {
    if (node.type === 'object' || node.type === 'array') {
      for (const child of node.children ?? []) {
        recurse(child, appendPointer(pointer, child.key as string | number));
      }
    } else {
      out.push(pointer);
    }
  };
  recurse(root, '');
  return out;
}

/**
 * Overwrite the scalar carrier of `target` in place with the value from
 * `scalar`, preserving the target's own key/id (only the value matters for
 * structural equality).
 */
function applyScalar(target: JsonNode, scalar: JsonNode): void {
  delete target.children;
  delete target.stringValue;
  delete target.numberValue;
  delete target.boolValue;
  target.type = scalar.type;
  if (scalar.type === 'string') target.stringValue = scalar.stringValue;
  if (scalar.type === 'number') target.numberValue = scalar.numberValue;
  if (scalar.type === 'boolean') target.boolValue = scalar.boolValue;
}

/** A clone of `root` with the scalar at `pointer` replaced by `scalar`. */
function withScalarAt(
  root: JsonNode,
  pointer: string,
  scalar: JsonNode,
): JsonNode {
  const clone = cloneNode(root);
  const target = resolvePointer(clone, pointer);
  if (target !== undefined) {
    applyScalar(target, scalar);
  }
  return clone;
}

/**
 * Plain-JSON projection of a scalar node, mirroring `merge.ts`'s conflict
 * carriers so the presented Base/Left/Right values can be compared directly.
 */
function toPlainScalar(node: JsonNode): unknown {
  switch (node.type) {
    case 'null':
      return null;
    case 'boolean':
      return node.boolValue ?? false;
    case 'string':
      return node.stringValue ?? '';
    case 'number':
      return Number(node.numberValue ?? '0');
    default:
      throw new Error(`not a scalar: ${node.type}`);
  }
}

/** Distinct sentinel scalars spanning every scalar type, used as fallbacks. */
const SENTINELS: Array<() => JsonNode> = [
  () => ({ id: 's', key: null, type: 'null' }),
  () => ({ id: 's', key: null, type: 'boolean', boolValue: true }),
  () => ({ id: 's', key: null, type: 'boolean', boolValue: false }),
  () => ({ id: 's', key: null, type: 'string', stringValue: '__sentinel_a__' }),
  () => ({ id: 's', key: null, type: 'string', stringValue: '__sentinel_b__' }),
  () => ({ id: 's', key: null, type: 'number', numberValue: '13579' }),
  () => ({ id: 's', key: null, type: 'number', numberValue: '24680' }),
];

/** First sentinel scalar structurally distinct from every excluded node. */
function firstScalarNotIn(excluded: JsonNode[]): JsonNode {
  for (const make of SENTINELS) {
    const candidate = make();
    if (!excluded.some((node) => structuralEquals(node, candidate))) {
      return candidate;
    }
  }
  // Unreachable: SENTINELS holds more distinct values than any exclusion set
  // built here (at most two excluded nodes).
  throw new Error('exhausted distinct sentinel scalars');
}

// ---------------------------------------------------------------------------
// Property 20: Three-way merge applies all non-conflicting changes
// ---------------------------------------------------------------------------

/** How a given leaf is changed relative to Base in a non-conflicting scenario. */
type Category = 'unchanged' | 'left' | 'right' | 'identical';

interface NonConflictingScenario {
  base: JsonNode;
  leafPointers: string[];
  categories: Category[];
  replacements: JsonNode[];
}

/**
 * A Base document with, for each of its scalar leaves, an independent
 * non-conflicting change assignment: unchanged, changed in Left only, changed
 * in Right only, or changed identically in both. Because every leaf is changed
 * on at most one "axis" (or identically on both), no two changes ever conflict.
 */
const nonConflictingScenarioArbitrary: fc.Arbitrary<NonConflictingScenario> =
  jsonArbitrary().chain((base) => {
    const leafPointers = scalarLeafPointers(base);
    const n = leafPointers.length;
    return fc
      .tuple(
        fc.array(
          fc.constantFrom<Category>('unchanged', 'left', 'right', 'identical'),
          { minLength: n, maxLength: n },
        ),
        fc.array(scalarJsonArbitrary(), { minLength: n, maxLength: n }),
      )
      .map(([categories, replacements]) => ({
        base,
        leafPointers,
        categories,
        replacements,
      }));
  });

describe('Property 20: Three-way merge applies all non-conflicting changes (Req 11.1, 11.2, 11.3, 11.4)', () => {
  // For a base and left/right whose per-leaf changes are non-conflicting
  // (left-only, right-only, or identical in both), the merge applies every
  // change with no conflict: the merged document equals the base with all of
  // those changes applied.
  test.prop([nonConflictingScenarioArbitrary], { numRuns: 100 })(
    'merge applies every non-conflicting change and marks no conflict',
    ({ base, leafPointers, categories, replacements }) => {
      const left = cloneNode(base);
      const right = cloneNode(base);
      const expected = cloneNode(base);

      leafPointers.forEach((pointer, index) => {
        const baseValue = resolvePointer(base, pointer)!;
        let value = replacements[index];
        // Force a genuine change so each category is meaningfully exercised.
        if (structuralEquals(value, baseValue)) {
          value = firstScalarNotIn([baseValue]);
        }

        const category = categories[index];
        if (category === 'left' || category === 'identical') {
          applyScalar(resolvePointer(left, pointer)!, value);
        }
        if (category === 'right' || category === 'identical') {
          applyScalar(resolvePointer(right, pointer)!, value);
        }
        if (category !== 'unchanged') {
          applyScalar(resolvePointer(expected, pointer)!, value);
        }
      });

      const result = threeWayMerge(base, left, right);

      // Req 11.4 (in part): identical and single-side changes raise no conflict.
      expect(result.conflicts).toEqual([]);
      // Req 11.1/11.2/11.3/11.4: every non-conflicting change is applied, taking
      // the left value, the right value, or the common value as appropriate.
      expect(structuralEquals(result.merged, expected)).toBe(true);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Property 21: Three-way merge detects and resolves conflicts
// ---------------------------------------------------------------------------

interface ConflictScenario {
  base: JsonNode;
  leafPointers: string[];
  rawIndex: number;
  rawLeft: JsonNode;
  rawRight: JsonNode;
  side: ConflictSide;
}

/**
 * A Base document plus the raw material to build a single genuine conflict: a
 * chosen scalar leaf, two candidate scalar values (normalized in the test so
 * both differ from Base and from each other), and the side to resolve with.
 */
const conflictScenarioArbitrary: fc.Arbitrary<ConflictScenario> =
  jsonArbitrary().chain((base) => {
    const leafPointers = scalarLeafPointers(base);
    return fc
      .tuple(
        fc.nat(),
        scalarJsonArbitrary(),
        scalarJsonArbitrary(),
        fc.constantFrom<ConflictSide>('base', 'left', 'right'),
      )
      .map(([rawIndex, rawLeft, rawRight, side]) => ({
        base,
        leafPointers,
        rawIndex,
        rawLeft,
        rawRight,
        side,
      }));
  });

describe('Property 21: Three-way merge detects and resolves conflicts (Req 11.5, 11.6)', () => {
  // For a path that resolves to incompatible values in Left and Right (each
  // differing from Base and from each other), the merge marks exactly that path
  // as a conflict presenting the Base/Left/Right values (Req 11.5); resolving it
  // with a chosen side applies that value at the path and clears the conflict
  // (Req 11.6).
  test.prop([conflictScenarioArbitrary], { numRuns: 100 })(
    'a conflicting path is marked, presents all three values, and resolves',
    ({ base, leafPointers, rawIndex, rawLeft, rawRight, side }) => {
      fc.pre(leafPointers.length > 0);
      const pointer = leafPointers[rawIndex % leafPointers.length];
      const baseValue = resolvePointer(base, pointer)!;

      // Build Left/Right values that genuinely conflict: each differs from Base,
      // and they differ from each other (which alone implies at least one
      // differs from Base, per Req 11.5).
      const leftValue = structuralEquals(rawLeft, baseValue)
        ? firstScalarNotIn([baseValue])
        : rawLeft;
      const rightValue =
        structuralEquals(rawRight, baseValue) ||
        structuralEquals(rawRight, leftValue)
          ? firstScalarNotIn([baseValue, leftValue])
          : rawRight;

      const left = withScalarAt(base, pointer, leftValue);
      const right = withScalarAt(base, pointer, rightValue);

      const result = threeWayMerge(base, left, right);

      // Req 11.5: exactly this path is marked as a conflict.
      expect(result.conflicts).toHaveLength(1);
      const conflict = result.conflicts[0];
      expect(conflict.path).toBe(pointer);
      // Req 11.5: the conflict presents the Base, Left, and Right values.
      expect(conflict.base).toEqual(toPlainScalar(baseValue));
      expect(conflict.left).toEqual(toPlainScalar(leftValue));
      expect(conflict.right).toEqual(toPlainScalar(rightValue));

      // Req 11.6: resolving with the chosen side applies that value and clears
      // the conflict.
      const chosen =
        side === 'base' ? baseValue : side === 'left' ? leftValue : rightValue;
      const resolved = resolveConflict(result, pointer, side, base, left, right);

      expect(resolved.conflicts).toEqual([]);
      const expected = withScalarAt(base, pointer, chosen);
      expect(structuralEquals(resolved.merged, expected)).toBe(true);
      return true;
    },
  );
});
