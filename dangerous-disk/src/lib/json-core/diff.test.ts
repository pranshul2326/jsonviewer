// Feature: json-viewer-free
//
// Property-based tests for the semantic (structural) diff (`diff.ts`):
//   - Property 15: Diff soundness (Req 8.7)
//   - Property 16: Diff invariance under key reordering and reformatting
//     (Req 8.2, 8.3)
//   - Property 17: Diff classifies each change correctly
//     (Req 8.1, 8.4, 8.5, 8.6)
//
// All inputs are drawn from the shared arbitraries in `src/test/arbitraries.ts`
// and equivalence is decided by the single oracle `structuralEquals` from
// `canonical.ts`. The tests deliberately avoid restating `semanticDiff`'s own
// logic: soundness is checked against the independent equality oracle, the
// invariance test transforms documents through real serialize/parse round-trips
// (changing whitespace outside string literals) plus key reordering, and the
// classification test constructs a single typed change and asserts the diff
// reports exactly that change.

import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from './types';
import { semanticDiff, type Difference, type DiffKind } from './diff';
import { format, type IndentStyle } from './serialize';
import { parseJson } from './parse';
import { jsonArbitrary, structuralEquals } from '../../test/arbitraries';

// ---------------------------------------------------------------------------
// Local helpers (written independently of `diff.ts`'s internals)
// ---------------------------------------------------------------------------

/** Deep-clone a `JsonNode` subtree (scalar carriers + ordered children). */
function cloneNode(node: JsonNode): JsonNode {
  return {
    ...node,
    children: node.children?.map(cloneNode),
  };
}

/** RFC 6901 reference-token escaping: `~` → `~0`, `/` → `~1` (order matters). */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** RFC 6901 reference-token unescaping: `~1` → `/`, `~0` → `~` (order matters). */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append a key/index to a JSON Pointer (root pointer is the empty string). */
function appendPointer(pointer: string, key: string | number): string {
  return `${pointer}/${escapeToken(String(key))}`;
}

interface PointerEntry {
  node: JsonNode;
  pointer: string;
}

/** Every node in the tree with its RFC 6901 JSON Pointer, in pre-order. */
function walkWithPointers(root: JsonNode): PointerEntry[] {
  const out: PointerEntry[] = [];
  const recurse = (node: JsonNode, pointer: string): void => {
    out.push({ node, pointer });
    for (const child of node.children ?? []) {
      recurse(child, appendPointer(pointer, child.key as string | number));
    }
  };
  recurse(root, '');
  return out;
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

/**
 * Return a structurally-equal copy with the order of every object's members
 * reversed (array order is preserved, since order is significant for arrays).
 * Reversing guarantees a genuinely different key order whenever an object has
 * more than one member.
 */
function reorderObjectKeys(node: JsonNode): JsonNode {
  if (node.type === 'object') {
    const reversed = (node.children ?? [])
      .map(reorderObjectKeys)
      .reverse();
    return { ...node, children: reversed };
  }
  if (node.type === 'array') {
    return { ...node, children: (node.children ?? []).map(reorderObjectKeys) };
  }
  return { ...node };
}

const TRUE_FALSE = new Set<DiffKind>(['addition', 'deletion', 'modification']);

const indentStyleArbitrary: fc.Arbitrary<IndentStyle> = fc.constantFrom<IndentStyle>(
  { kind: 'space', size: 2 },
  { kind: 'space', size: 4 },
  { kind: 'tab' },
);

/**
 * A pair of documents that exercises *both* directions of the soundness iff:
 * roughly half the pairs are independently generated (almost always unequal),
 * and half are an exact structural copy produced by reordering object keys (so
 * the equal branch is reliably hit).
 */
const documentPairArbitrary: fc.Arbitrary<[JsonNode, JsonNode]> = fc.oneof(
  fc.tuple(jsonArbitrary(), jsonArbitrary()),
  jsonArbitrary().map(
    (model): [JsonNode, JsonNode] => [model, reorderObjectKeys(cloneNode(model))],
  ),
);

// ---------------------------------------------------------------------------
// Property 15: Diff soundness
// ---------------------------------------------------------------------------

describe('Property 15: Diff soundness (Req 8.7)', () => {
  // semanticDiff reports zero differences if and only if the two documents are
  // structurally equivalent (decided independently by `structuralEquals`).
  test.prop([documentPairArbitrary], { numRuns: 100 })(
    'zero differences iff structurally equivalent',
    ([left, right]) => {
      const noDifferences = semanticDiff(left, right).length === 0;
      const equivalent = structuralEquals(left, right);
      expect(noDifferences).toBe(equivalent);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Property 16: Diff invariance under key reordering and reformatting
// ---------------------------------------------------------------------------

describe('Property 16: Diff invariance under key reordering and reformatting (Req 8.2, 8.3)', () => {
  // Comparing a document against a copy whose object keys are reordered and
  // whose text has been reformatted (whitespace changed outside string
  // literals, via a real format -> parse round-trip) reports zero differences.
  test.prop([jsonArbitrary(), indentStyleArbitrary], { numRuns: 100 })(
    'reordering keys and reformatting text yields zero differences',
    (model, style) => {
      // Reorder object keys (Req 8.2), then reformat by serializing with the
      // chosen indentation and re-parsing (Req 8.3: whitespace outside string
      // values changes but is discarded on parse).
      const reordered = reorderObjectKeys(cloneNode(model));
      const reformattedText = format(reordered, style);

      const parsed = parseJson(reformattedText);
      // A non-empty model must parse back to a model; guard explicitly so a
      // parse regression surfaces as a clear failure rather than a type error.
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.empty) {
        throw new Error('reformatted text did not parse back to a model');
      }

      const differences = semanticDiff(model, parsed.model);
      expect(differences).toEqual([]);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Property 17: Diff classifies each change correctly
// ---------------------------------------------------------------------------

/** Build a fresh scalar child node for a synthetic addition. */
function addedScalar(key: string): JsonNode {
  return { id: `added/${key}`, key, type: 'string', stringValue: '__added__' };
}

/** Candidate replacement scalars spanning distinct types/values. */
const REPLACEMENT_SCALARS: Array<() => JsonNode> = [
  () => ({ id: 'r', key: null, type: 'null' }),
  () => ({ id: 'r', key: null, type: 'boolean', boolValue: true }),
  () => ({ id: 'r', key: null, type: 'boolean', boolValue: false }),
  () => ({ id: 'r', key: null, type: 'string', stringValue: '__modified_sentinel__' }),
  () => ({ id: 'r', key: null, type: 'number', numberValue: '987654321.123456789' }),
];

/** A scalar structurally different from `current`, or undefined if none. */
function differentScalar(current: JsonNode): JsonNode | undefined {
  for (const make of REPLACEMENT_SCALARS) {
    const candidate = make();
    if (!structuralEquals(current, candidate)) return candidate;
  }
  return undefined;
}

/** True for the four scalar (leaf) types. */
function isScalar(node: JsonNode): boolean {
  return (
    node.type === 'null' ||
    node.type === 'boolean' ||
    node.type === 'string' ||
    node.type === 'number'
  );
}

describe('Property 17: Diff classifies each change correctly (Req 8.1, 8.4, 8.5, 8.6)', () => {
  // Addition (Req 8.4): adding a value at a new path produces exactly one
  // difference at that path, classified as an addition.
  test.prop([jsonArbitrary(), fc.nat()], { numRuns: 100 })(
    'adding a value at a new path reports exactly one addition',
    (model, rawIndex) => {
      // Target any object node (the new key lives inside it).
      const objects = walkWithPointers(model).filter(
        (entry) => entry.node.type === 'object',
      );
      fc.pre(objects.length > 0);
      const target = objects[rawIndex % objects.length];

      // Choose a key not already present in the target object.
      const existing = new Set(
        (target.node.children ?? []).map((child) => String(child.key)),
      );
      let key = 'newKey';
      while (existing.has(key)) key += '_';

      const right = cloneNode(model);
      const rightTarget = resolvePointer(right, target.pointer)!;
      rightTarget.children = [...(rightTarget.children ?? []), addedScalar(key)];

      const differences = semanticDiff(model, right);
      const expectedPointer = appendPointer(target.pointer, key);

      expect(differences).toHaveLength(1);
      expect(differences[0].kind).toBe('addition');
      expect(differences[0].path).toBe(expectedPointer);
      return true;
    },
  );

  // Deletion (Req 8.5): removing a value at an existing path produces exactly
  // one difference at that path, classified as a deletion.
  test.prop([jsonArbitrary(), fc.nat()], { numRuns: 100 })(
    'removing a value at an existing path reports exactly one deletion',
    (model, rawIndex) => {
      // Target an object member (object deletion does not shift sibling paths).
      const members = walkWithPointers(model).filter(
        (entry) =>
          entry.node.type === 'object' && (entry.node.children?.length ?? 0) > 0,
      );
      fc.pre(members.length > 0);
      const parent = members[rawIndex % members.length];

      const childIndex = rawIndex % parent.node.children!.length;
      const removedChild = parent.node.children![childIndex];
      const expectedPointer = appendPointer(
        parent.pointer,
        removedChild.key as string | number,
      );

      const right = cloneNode(model);
      const rightParent = resolvePointer(right, parent.pointer)!;
      rightParent.children = rightParent.children!.filter(
        (_, index) => index !== childIndex,
      );

      const differences = semanticDiff(model, right);

      expect(differences).toHaveLength(1);
      expect(differences[0].kind).toBe('deletion');
      expect(differences[0].path).toBe(expectedPointer);
      return true;
    },
  );

  // Modification (Req 8.6): changing a scalar at an existing path produces
  // exactly one difference at that path, classified as a modification.
  test.prop([jsonArbitrary(), fc.nat()], { numRuns: 100 })(
    'changing a scalar at an existing path reports exactly one modification',
    (model, rawIndex) => {
      const scalars = walkWithPointers(model).filter((entry) =>
        isScalar(entry.node),
      );
      fc.pre(scalars.length > 0);
      const target = scalars[rawIndex % scalars.length];

      const replacement = differentScalar(target.node);
      fc.pre(replacement !== undefined);

      const right = cloneNode(model);
      const rightTarget = resolvePointer(right, target.pointer)!;
      // Replace the scalar value in place, preserving the node's key/id.
      delete rightTarget.stringValue;
      delete rightTarget.numberValue;
      delete rightTarget.boolValue;
      delete rightTarget.children;
      rightTarget.type = replacement!.type;
      if (replacement!.type === 'string') rightTarget.stringValue = replacement!.stringValue;
      if (replacement!.type === 'number') rightTarget.numberValue = replacement!.numberValue;
      if (replacement!.type === 'boolean') rightTarget.boolValue = replacement!.boolValue;

      const differences = semanticDiff(model, right);

      expect(differences).toHaveLength(1);
      expect(differences[0].kind).toBe('modification');
      expect(differences[0].path).toBe(target.pointer);
      return true;
    },
  );

  // Every reported difference carries exactly one valid classification and a
  // path that resolves in the document the classification implies (additions
  // in Right, deletions in Left, modifications in both).
  test.prop([documentPairArbitrary], { numRuns: 100 })(
    'every difference has one classification and a resolvable path',
    ([left, right]) => {
      const differences: Difference[] = semanticDiff(left, right);
      for (const diff of differences) {
        expect(TRUE_FALSE.has(diff.kind)).toBe(true);
        if (diff.kind === 'addition') {
          expect(resolvePointer(right, diff.path)).toBeDefined();
        } else if (diff.kind === 'deletion') {
          expect(resolvePointer(left, diff.path)).toBeDefined();
        } else {
          expect(resolvePointer(left, diff.path)).toBeDefined();
          expect(resolvePointer(right, diff.path)).toBeDefined();
        }
      }
      return true;
    },
  );
});
