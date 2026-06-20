// Feature: json-viewer-free
//
// Semantic (structural) diff for the pure `json-core` library.
//
//   semanticDiff(left, right) : (JsonNode, JsonNode) -> Difference[]
//
// The diff compares two documents *by structure*, built on the same
// canonicalization basis (`canonical.ts`) used for every equivalence check in
// the system. Concretely:
//   - Object members are matched by key, so differences in object key ordering
//     produce ZERO differences (Req 8.2).
//   - Whitespace outside string values never reaches the data model (it is
//     discarded during parsing), so reformatting produces ZERO differences
//     (Req 8.3).
//   - Scalar equality is decided by `structuralEquals` (the canonical oracle),
//     so numbers that are numerically equal but written differently (e.g.
//     `1.0` vs `1`, `1e2` vs `100`) are not reported as differences.
//
// Each reported `Difference` identifies a path and is classified as exactly one
// of `addition`, `deletion`, or `modification` (Req 8.1):
//   - addition     — a path resolves in Right but not in Left (Req 8.4),
//   - deletion     — a path resolves in Left but not in Right (Req 8.5),
//   - modification — a path resolves to differing values in both (Req 8.6).
//
// For nested structures the algorithm recurses so that differences are reported
// at the most specific differing path rather than at an enclosing container.
//
// Paths are expressed as RFC 6901 JSON Pointers (the document root is the empty
// string `""`). This is the same path vocabulary used by RFC 6902 JSON Patch
// (see `patch.ts`), keeping the two features consistent.

import type { JsonNode } from './types';
import { structuralEquals } from './canonical';

/** The three mutually exclusive ways a path can differ between two documents. */
export type DiffKind = 'addition' | 'deletion' | 'modification';

/**
 * A single structural difference between a Left and a Right document.
 *
 * `path` is an RFC 6901 JSON Pointer identifying the differing location. The
 * value carriers are populated according to `kind`:
 *   - `addition`     populates `right` (the value present only in Right),
 *   - `deletion`     populates `left`  (the value present only in Left),
 *   - `modification` populates both `left` and `right`.
 *
 * The `left`/`right` carriers are display-oriented plain JSON values; the
 * decision of *whether* a difference exists is made entirely on the canonical
 * (structural) basis, never on these payloads.
 */
export interface Difference {
  path: string;
  kind: DiffKind;
  left?: unknown;
  right?: unknown;
}

/**
 * Escape a single JSON Pointer reference token per RFC 6901: `~` becomes `~0`
 * and `/` becomes `~1` (the `~` replacement must happen first).
 */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Append an object key or array index to a JSON Pointer. */
function appendPointer(pointer: string, key: string | number): string {
  return `${pointer}/${escapePointerToken(String(key))}`;
}

/**
 * Convert a `JsonNode` subtree into a plain JSON value for the `left`/`right`
 * difference payloads. Numbers are surfaced as JavaScript numbers for
 * ergonomic display; equivalence is never decided from these values, so the
 * (rare) precision loss for very large integers has no effect on correctness.
 */
function toPlain(node: JsonNode): unknown {
  switch (node.type) {
    case 'null':
      return null;
    case 'boolean':
      return node.boolValue ?? false;
    case 'string':
      return node.stringValue ?? '';
    case 'number':
      return Number(node.numberValue ?? '0');
    case 'array':
      return (node.children ?? []).map((child) => toPlain(child));
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const child of node.children ?? []) {
        result[String(child.key)] = toPlain(child);
      }
      return result;
    }
    default: {
      // Exhaustiveness guard: every JsonType is handled above.
      const _exhaustive: never = node.type;
      throw new Error(`Unsupported JsonType: ${String(_exhaustive)}`);
    }
  }
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

/**
 * Recursively diff two nodes that occupy the same `pointer`, appending every
 * discovered difference to `out`.
 */
function diffNodes(
  left: JsonNode,
  right: JsonNode,
  pointer: string,
  out: Difference[],
): void {
  // Differing container/scalar shape (e.g. object vs array, array vs string):
  // the value at this path changed wholesale, so report a single modification
  // at this — the most specific differing — path rather than recursing.
  if (left.type !== right.type) {
    out.push({
      path: pointer,
      kind: 'modification',
      left: toPlain(left),
      right: toPlain(right),
    });
    return;
  }

  if (left.type === 'object') {
    diffObjects(left, right, pointer, out);
    return;
  }

  if (left.type === 'array') {
    diffArrays(left, right, pointer, out);
    return;
  }

  // Both nodes are scalars of the same type: compare on the canonical basis so
  // that, e.g., `1.0` and `1` are not reported as a difference.
  if (isScalar(left) && !structuralEquals(left, right)) {
    out.push({
      path: pointer,
      kind: 'modification',
      left: toPlain(left),
      right: toPlain(right),
    });
  }
}

/**
 * Diff two object nodes by matching members on key (order-independent), so a
 * key present only in Right is an addition, a key present only in Left is a
 * deletion, and a shared key recurses to its most specific difference.
 */
function diffObjects(
  left: JsonNode,
  right: JsonNode,
  pointer: string,
  out: Difference[],
): void {
  const leftChildren = left.children ?? [];
  const rightChildren = right.children ?? [];

  const leftByKey = new Map<string, JsonNode>();
  for (const child of leftChildren) {
    leftByKey.set(String(child.key), child);
  }
  const rightByKey = new Map<string, JsonNode>();
  for (const child of rightChildren) {
    rightByKey.set(String(child.key), child);
  }

  // Walk Left members in source order: deletions and recursive comparisons.
  for (const child of leftChildren) {
    const key = String(child.key);
    const childPointer = appendPointer(pointer, key);
    const counterpart = rightByKey.get(key);
    if (counterpart === undefined) {
      out.push({ path: childPointer, kind: 'deletion', left: toPlain(child) });
    } else {
      diffNodes(child, counterpart, childPointer, out);
    }
  }

  // Walk Right members in source order: keys absent from Left are additions.
  for (const child of rightChildren) {
    const key = String(child.key);
    if (!leftByKey.has(key)) {
      out.push({
        path: appendPointer(pointer, key),
        kind: 'addition',
        right: toPlain(child),
      });
    }
  }
}

/**
 * Diff two array nodes positionally: equal-index elements recurse; trailing
 * elements present only in Right are additions and those present only in Left
 * are deletions.
 */
function diffArrays(
  left: JsonNode,
  right: JsonNode,
  pointer: string,
  out: Difference[],
): void {
  const leftChildren = left.children ?? [];
  const rightChildren = right.children ?? [];
  const shared = Math.min(leftChildren.length, rightChildren.length);

  for (let i = 0; i < shared; i++) {
    diffNodes(leftChildren[i], rightChildren[i], appendPointer(pointer, i), out);
  }

  // Right has more elements: the extra trailing indices are additions.
  for (let i = shared; i < rightChildren.length; i++) {
    out.push({
      path: appendPointer(pointer, i),
      kind: 'addition',
      right: toPlain(rightChildren[i]),
    });
  }

  // Left has more elements: the extra trailing indices are deletions.
  for (let i = shared; i < leftChildren.length; i++) {
    out.push({
      path: appendPointer(pointer, i),
      kind: 'deletion',
      left: toPlain(leftChildren[i]),
    });
  }
}

/**
 * Compute the semantic (structural) differences between a Left and a Right
 * document.
 *
 * The result is a list of path-keyed {@link Difference}s, each classified as
 * exactly one of `addition`, `deletion`, or `modification`. Documents that are
 * structurally equivalent — differing only in object key ordering, in
 * insignificant whitespace, or in equivalent numeric lexemes — yield an empty
 * list.
 *
 * @param left  The Left document model.
 * @param right The Right document model.
 * @returns The differences, ordered by a depth-first walk of the documents.
 */
export function semanticDiff(left: JsonNode, right: JsonNode): Difference[] {
  const differences: Difference[] = [];
  diffNodes(left, right, '', differences);
  return differences;
}
