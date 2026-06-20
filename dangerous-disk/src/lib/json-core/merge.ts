// Feature: json-viewer-free
//
// Three-way merge for the pure `json-core` library.
//
//   threeWayMerge(base, left, right) : (JsonNode, JsonNode, JsonNode) -> MergeResult
//   resolveConflict(result, path, side, base, left, right) : -> MergeResult
//
// The merge reconciles a Left and a Right document against a common Base,
// deciding every difference on the same canonicalization basis (`canonical.ts`)
// used for every equivalence check in the system. For each JSON_Path the merge
// classifies the change relative to Base:
//
//   - changed in Left only   (Left ≠ Base, Right = Base)            -> take Left  (Req 11.2)
//   - changed in Right only  (Right ≠ Base, Left = Base)            -> take Right (Req 11.3)
//   - changed identically    (Left = Right, both ≠ Base)           -> take that common value, no conflict (Req 11.4)
//   - changed differently    (Left ≠ Right, at least one ≠ Base)   -> mark a conflict presenting Base/Left/Right (Req 11.5)
//
// Every non-conflicting change is incorporated into the merged document
// (Req 11.1). To apply non-conflicting changes at the finest granularity, when
// all three documents resolve to containers of the same type at a path the
// merge recurses member-by-member (objects) or position-by-position (arrays),
// so a Left-only change to one key and a Right-only change to a sibling key are
// both applied without raising a conflict.
//
// `resolveConflict` applies a user's chosen side (Base, Left, or Right) at a
// conflicting path and clears that conflict (Req 11.6).
//
// Paths are RFC 6901 JSON Pointers (the document root is the empty string `""`),
// matching the vocabulary used by `diff.ts` and `patch.ts`.

import type { JsonNode } from './types';
import { structuralEquals } from './canonical';

/** A single conflicting JSON_Path, presenting the three competing values. */
export interface Conflict {
  /** RFC 6901 JSON Pointer identifying the conflicting location. */
  path: string;
  /** The Base value at the path (omitted when absent in Base). */
  base?: unknown;
  /** The Left value at the path (omitted when absent in Left). */
  left?: unknown;
  /** The Right value at the path (omitted when absent in Right). */
  right?: unknown;
}

/**
 * The outcome of a three-way merge: a best-effort merged document (with every
 * non-conflicting change applied and, for unresolved conflicts, a placeholder
 * value) plus the list of conflicts still requiring resolution.
 */
export interface MergeResult {
  merged: JsonNode;
  conflicts: Conflict[];
}

/** The side a user may pick to resolve a conflict. */
export type ConflictSide = 'base' | 'left' | 'right';

/** Id of the document root node. */
const ROOT_ID = '$';

/**
 * Build a stable child id from a parent id and a key (mirrors `model.ts` so the
 * merged tree carries the same id scheme as freshly-parsed documents).
 */
function childId(parentId: string, key: string | number): string {
  return `${parentId}/${encodeURIComponent(String(key))}`;
}

/** Escape a single JSON Pointer reference token per RFC 6901. */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Unescape a single JSON Pointer reference token per RFC 6901. */
function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append an object key or array index to a JSON Pointer. */
function appendPointer(pointer: string, key: string | number): string {
  return `${pointer}/${escapePointerToken(String(key))}`;
}

/**
 * Convert a `JsonNode` subtree into a plain JSON value for the conflict
 * display carriers. Equivalence is never decided from these payloads, so the
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
      const _exhaustive: never = node.type;
      throw new Error(`Unsupported JsonType: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Structural equality that also treats "absent" (`undefined`) as a value: two
 * absences are equal, and an absence never equals a present node.
 */
function nodesEqual(a: JsonNode | undefined, b: JsonNode | undefined): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return structuralEquals(a, b);
}

/** Find a container child by its key (object property name or array index). */
function childByKey(
  node: JsonNode | undefined,
  key: string,
): JsonNode | undefined {
  if (node === undefined || node.children === undefined) {
    return undefined;
  }
  return node.children.find((child) => String(child.key) === key);
}

/** True when a node is a present container of the given type. */
function isContainer(
  node: JsonNode | undefined,
  type: 'object' | 'array',
): node is JsonNode {
  return node !== undefined && node.type === type;
}

/**
 * Rebuild a merged subtree with a fresh, consistent id scheme and (for arrays)
 * sequential indices, leaving object key order untouched. The merge composes
 * nodes from three sources, so a final normalization pass keeps ids/keys
 * coherent with the rest of `json-core`.
 */
function rebuild(
  node: JsonNode,
  key: string | number | null,
  id: string,
): JsonNode {
  switch (node.type) {
    case 'null':
      return { id, key, type: 'null' };
    case 'boolean':
      return { id, key, type: 'boolean', boolValue: node.boolValue ?? false };
    case 'string':
      return { id, key, type: 'string', stringValue: node.stringValue ?? '' };
    case 'number':
      return { id, key, type: 'number', numberValue: node.numberValue ?? '0' };
    case 'array': {
      const children = (node.children ?? []).map((child, index) =>
        rebuild(child, index, childId(id, index)),
      );
      return { id, key, type: 'array', children };
    }
    case 'object': {
      const children = (node.children ?? []).map((child) =>
        rebuild(child, child.key, childId(id, String(child.key))),
      );
      return { id, key, type: 'object', children };
    }
    default: {
      const _exhaustive: never = node.type;
      throw new Error(`Unsupported JsonType: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Record a conflict at `path`, populating only the carriers whose side is
 * present, and return the best-effort placeholder value to keep in the merged
 * document (Left if present, else Right, else Base, else absent).
 */
function recordConflict(
  path: string,
  base: JsonNode | undefined,
  left: JsonNode | undefined,
  right: JsonNode | undefined,
  conflicts: Conflict[],
): JsonNode | undefined {
  const conflict: Conflict = { path };
  if (base !== undefined) {
    conflict.base = toPlain(base);
  }
  if (left !== undefined) {
    conflict.left = toPlain(left);
  }
  if (right !== undefined) {
    conflict.right = toPlain(right);
  }
  conflicts.push(conflict);
  return left ?? right ?? base;
}

/**
 * Merge a single position across Base/Left/Right. Returns the merged node, or
 * `undefined` when the position is absent (deleted) in the merged document, and
 * appends any conflicts (with absolute paths) to `conflicts`.
 */
function mergeNode(
  path: string,
  base: JsonNode | undefined,
  left: JsonNode | undefined,
  right: JsonNode | undefined,
  conflicts: Conflict[],
): JsonNode | undefined {
  // Left and Right agree: take that value (covers unchanged paths and changes
  // made identically in both — Req 11.4). No conflict.
  if (nodesEqual(left, right)) {
    return left;
  }

  // Right is unchanged from Base: the change came from Left only (Req 11.2).
  if (nodesEqual(right, base)) {
    return left;
  }

  // Left is unchanged from Base: the change came from Right only (Req 11.3).
  if (nodesEqual(left, base)) {
    return right;
  }

  // Left, Right, and Base all differ. Recurse to apply non-conflicting changes
  // at finer granularity when all three sides are containers of the same type.
  if (
    isContainer(base, 'object') &&
    isContainer(left, 'object') &&
    isContainer(right, 'object')
  ) {
    return mergeObjects(path, base, left, right, conflicts);
  }
  if (
    isContainer(base, 'array') &&
    isContainer(left, 'array') &&
    isContainer(right, 'array')
  ) {
    return mergeArrays(path, base, left, right, conflicts);
  }

  // Genuine conflict at this path (Req 11.5).
  return recordConflict(path, base, left, right, conflicts);
}

/**
 * Merge three object nodes member-by-member over the union of their keys
 * (Base order first, then Left-only keys, then Right-only keys), recursing into
 * each member so sibling changes from different sides both apply.
 */
function mergeObjects(
  path: string,
  base: JsonNode,
  left: JsonNode,
  right: JsonNode,
  conflicts: Conflict[],
): JsonNode {
  const keys: string[] = [];
  const seen = new Set<string>();
  const collect = (node: JsonNode) => {
    for (const child of node.children ?? []) {
      const key = String(child.key);
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  };
  collect(base);
  collect(left);
  collect(right);

  const children: JsonNode[] = [];
  for (const key of keys) {
    const merged = mergeNode(
      appendPointer(path, key),
      childByKey(base, key),
      childByKey(left, key),
      childByKey(right, key),
      conflicts,
    );
    if (merged !== undefined) {
      children.push({ ...merged, key });
    }
  }
  return { id: path, key: null, type: 'object', children };
}

/**
 * Merge three array nodes position-by-position over the maximum length. Absent
 * positions (beyond a side's length) participate as `undefined`, so trailing
 * additions and deletions follow the same change-classification rules.
 */
function mergeArrays(
  path: string,
  base: JsonNode,
  left: JsonNode,
  right: JsonNode,
  conflicts: Conflict[],
): JsonNode {
  const baseChildren = base.children ?? [];
  const leftChildren = left.children ?? [];
  const rightChildren = right.children ?? [];
  const length = Math.max(
    baseChildren.length,
    leftChildren.length,
    rightChildren.length,
  );

  const children: JsonNode[] = [];
  for (let i = 0; i < length; i++) {
    const merged = mergeNode(
      appendPointer(path, i),
      baseChildren[i],
      leftChildren[i],
      rightChildren[i],
      conflicts,
    );
    if (merged !== undefined) {
      children.push(merged);
    }
  }
  return { id: path, key: null, type: 'array', children };
}

/**
 * Compute a three-way merge of `left` and `right` against their common `base`.
 *
 * Every non-conflicting change is applied to the returned `merged` document;
 * paths that changed incompatibly are returned in `conflicts` (each presenting
 * the Base, Left, and Right values) and carry a best-effort placeholder value
 * in `merged` until resolved via {@link resolveConflict}.
 *
 * @param base  The common ancestor document model.
 * @param left  The Left document model.
 * @param right The Right document model.
 */
export function threeWayMerge(
  base: JsonNode,
  left: JsonNode,
  right: JsonNode,
): MergeResult {
  const conflicts: Conflict[] = [];
  const merged = mergeNode('', base, left, right, conflicts);
  // The root is always present (all three inputs are valid documents).
  const root = merged ?? { id: ROOT_ID, key: null, type: 'null' };
  return { merged: rebuild(root, null, ROOT_ID), conflicts };
}

/** Split a JSON Pointer into its decoded reference tokens (root => `[]`). */
function pointerTokens(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  return pointer
    .split('/')
    .slice(1)
    .map((token) => unescapePointerToken(token));
}

/** Resolve the node at a JSON Pointer within a document, if present. */
function getAtPointer(
  root: JsonNode,
  pointer: string,
): JsonNode | undefined {
  let current: JsonNode | undefined = root;
  for (const token of pointerTokens(pointer)) {
    current = childByKey(current, token);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/**
 * Return a copy of `root` with the node at `pointer` set to `value`, or removed
 * when `value` is `undefined`. Missing object keys along the path are created;
 * the returned tree is normalized (ids/array indices rebuilt).
 */
function setAtPointer(
  root: JsonNode,
  pointer: string,
  value: JsonNode | undefined,
): JsonNode {
  const tokens = pointerTokens(pointer);

  // Setting the root replaces the whole document (deletion falls back to null).
  if (tokens.length === 0) {
    const next = value ?? { id: ROOT_ID, key: null, type: 'null' };
    return rebuild(next, null, ROOT_ID);
  }

  const set = (node: JsonNode, depth: number): JsonNode => {
    const key = tokens[depth];
    const isLast = depth === tokens.length - 1;
    const existingChildren = node.children ?? [];

    if (isLast) {
      const filtered = existingChildren.filter(
        (child) => String(child.key) !== key,
      );
      if (value === undefined) {
        // Deletion: drop the child if it existed.
        return { ...node, children: filtered };
      }
      const replacement: JsonNode = { ...value, key };
      const index = existingChildren.findIndex(
        (child) => String(child.key) === key,
      );
      if (index === -1) {
        // New key appended in source order.
        return { ...node, children: [...existingChildren, replacement] };
      }
      const children = existingChildren.slice();
      children[index] = replacement;
      return { ...node, children };
    }

    // Descend, creating an intermediate object if the path does not yet exist.
    const index = existingChildren.findIndex(
      (child) => String(child.key) === key,
    );
    const childNode: JsonNode =
      index === -1
        ? { id: '', key, type: 'object', children: [] }
        : existingChildren[index];
    const updatedChild = set(childNode, depth + 1);
    const children = existingChildren.slice();
    if (index === -1) {
      children.push(updatedChild);
    } else {
      children[index] = updatedChild;
    }
    return { ...node, children };
  };

  return rebuild(set(root, 0), null, ROOT_ID);
}

/**
 * Resolve a single conflict by applying the value from the chosen side
 * (`'base' | 'left' | 'right'`) at the conflicting path, then clearing that
 * conflict (Req 11.6). If the chosen side has no value at the path (the side
 * deleted it), the path is removed from the merged document.
 *
 * Returns a new {@link MergeResult}; the inputs are not mutated. A `path` that
 * is not an open conflict is returned unchanged.
 *
 * @param result The current merge result to update.
 * @param path   The conflicting JSON Pointer to resolve.
 * @param side   Which document's value to apply.
 * @param base   The original Base document model.
 * @param left   The original Left document model.
 * @param right  The original Right document model.
 */
export function resolveConflict(
  result: MergeResult,
  path: string,
  side: ConflictSide,
  base: JsonNode,
  left: JsonNode,
  right: JsonNode,
): MergeResult {
  const hasConflict = result.conflicts.some(
    (conflict) => conflict.path === path,
  );
  if (!hasConflict) {
    return result;
  }

  const source = side === 'base' ? base : side === 'left' ? left : right;
  const chosen = getAtPointer(source, path);

  return {
    merged: setAtPointer(result.merged, path, chosen),
    conflicts: result.conflicts.filter((conflict) => conflict.path !== path),
  };
}
