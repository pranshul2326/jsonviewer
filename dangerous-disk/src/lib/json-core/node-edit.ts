// Feature: json-viewer-free
//
// Pure, framework-free node-edit operations for the Tree_View (Req 2.1–2.7).
//
//   addKey(root, parentId, key, value)   : insert a new object member (Req 2.1)
//   deleteNode(root, nodeId)             : remove a node            (Req 2.2)
//   renameKey(root, nodeId, newKey)      : rename an object key     (Req 2.3)
//   setScalar(root, nodeId, value)       : replace a scalar value   (Req 2.4)
//   editScalarText(root, nodeId, text)   : parse text then setScalar (Req 2.4/2.7)
//
// Every operation is *pure*: it never mutates its `root` argument and returns a
// freshly-built tree on success. The returned model is re-indexed from the
// document root so its node ids and array-index keys follow the same scheme as
// the parser (`model.ts`), which guarantees the round-trip property — applying
// an operation and re-parsing the serialized editor text yields a model equal
// to the directly-mutated model (Req 2.8, design Property 10).
//
// Rejections are returned as data, never thrown, so the UI can surface an error
// message while leaving the document unchanged:
//   - duplicate-key  — add/rename to a key already present in the same object;
//                      the result identifies the conflicting key (Req 2.5, 2.6).
//   - invalid-scalar — a scalar edit whose text is not a valid JSON scalar
//                      (Req 2.7).
//   - invalid-target — the target node does not support the operation (a guard
//                      for callers; the Tree_View UI never offers such an edit).
//
// These functions are exported for direct property/unit testing (task 13.6).

import { parseJson } from './parse';
import type { JsonNode, JsonType } from './types';

// ---------------------------------------------------------------------------
// Result + error types
// ---------------------------------------------------------------------------

/** The category of an edit rejection. */
export type EditErrorKind = 'duplicate-key' | 'invalid-scalar' | 'invalid-target';

/** A rejected edit: a category, a human-readable message, and any conflicting key. */
export interface EditError {
  /** The rejection category. */
  kind: EditErrorKind;
  /** A message suitable for display to the user. */
  message: string;
  /** For `duplicate-key`, the existing key that caused the conflict (Req 2.5/2.6). */
  conflictingKey?: string;
}

/** The outcome of an edit: a new model on success, or a typed rejection. */
export type EditResult =
  | { ok: true; model: JsonNode }
  | { ok: false; error: EditError };

// ---------------------------------------------------------------------------
// Id / re-index helpers (mirror model.ts so parser and editor agree)
// ---------------------------------------------------------------------------

/** Id of the document root node (mirrors `model.ts`). */
const ROOT_ID = '$';

/** Build a stable child id from a parent id and a key (mirrors `model.ts`). */
function childId(parentId: string, key: string | number): string {
  return `${parentId}/${encodeURIComponent(String(key))}`;
}

/** The four scalar JSON types. */
const SCALAR_TYPES: ReadonlySet<JsonType> = new Set<JsonType>([
  'string',
  'number',
  'boolean',
  'null',
]);

/** Whether a node type is a scalar (string, number, boolean, or null). */
export function isScalarType(type: JsonType): boolean {
  return SCALAR_TYPES.has(type);
}

/**
 * Rebuild a node (and all descendants) with parser-consistent keys and ids:
 * array children take their positional index as key, object children keep their
 * key, and every id is derived from its parent id and key. This produces a fully
 * fresh tree (no references shared with the input) whose shape matches what the
 * parser would produce for the equivalent text.
 */
export function reindex(
  node: JsonNode,
  key: string | number | null,
  id: string,
): JsonNode {
  switch (node.type) {
    case 'array':
      return {
        id,
        key,
        type: 'array',
        children: (node.children ?? []).map((child, index) =>
          reindex(child, index, childId(id, index)),
        ),
      };
    case 'object':
      return {
        id,
        key,
        type: 'object',
        children: (node.children ?? []).map((child) =>
          reindex(child, child.key, childId(id, String(child.key))),
        ),
      };
    case 'string':
      return { id, key, type: 'string', stringValue: node.stringValue ?? '' };
    case 'number':
      return { id, key, type: 'number', numberValue: node.numberValue ?? '0' };
    case 'boolean':
      return { id, key, type: 'boolean', boolValue: node.boolValue ?? false };
    case 'null':
      return { id, key, type: 'null' };
    default: {
      const _exhaustive: never = node.type;
      throw new Error(`Unsupported JsonType: ${String(_exhaustive)}`);
    }
  }
}

/** Re-index a tree from the document root and return it as the success result. */
function finalize(root: JsonNode): EditResult {
  return { ok: true, model: reindex(root, null, ROOT_ID) };
}

// ---------------------------------------------------------------------------
// Tree lookup + immutable transform
// ---------------------------------------------------------------------------

/** Find the node with the given id, or `undefined` if none exists. */
export function findNode(root: JsonNode, id: string): JsonNode | undefined {
  if (root.id === id) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Find the parent of the node with the given id, or `undefined` if none/root. */
export function findParent(root: JsonNode, id: string): JsonNode | undefined {
  if (root.children) {
    for (const child of root.children) {
      if (child.id === id) return root;
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Return a new tree in which the node with `id` is replaced by `fn(node)`.
 * Ancestors along the path are rebuilt; unrelated branches are shared. Does not
 * mutate `node`.
 */
function transformNode(
  node: JsonNode,
  id: string,
  fn: (n: JsonNode) => JsonNode,
): JsonNode {
  if (node.id === id) return fn(node);
  if (node.children) {
    let changed = false;
    const next = node.children.map((child) => {
      const updated = transformNode(child, id, fn);
      if (updated !== child) changed = true;
      return updated;
    });
    if (changed) return { ...node, children: next };
  }
  return node;
}

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

/**
 * Insert a new member `key` -> `value` into the object node identified by
 * `parentId` (Req 2.1). Rejected with `duplicate-key` if the object already
 * contains `key`, leaving the object unchanged (Req 2.6). Rejected with
 * `invalid-target` if `parentId` is not an object node.
 */
export function addKey(
  root: JsonNode,
  parentId: string,
  key: string,
  value: JsonNode,
): EditResult {
  const parent = findNode(root, parentId);
  if (!parent || parent.type !== 'object') {
    return {
      ok: false,
      error: { kind: 'invalid-target', message: 'Can only add a key to an object.' },
    };
  }

  const children = parent.children ?? [];
  if (children.some((child) => String(child.key) === key)) {
    return {
      ok: false,
      error: {
        kind: 'duplicate-key',
        conflictingKey: key,
        message: `Cannot add key "${key}": it already exists in this object.`,
      },
    };
  }

  // The value's key/id are placeholders; finalize() re-indexes the whole tree.
  const newChild: JsonNode = { ...value, key };
  const next = transformNode(root, parentId, (n) => ({
    ...n,
    children: [...(n.children ?? []), newChild],
  }));
  return finalize(next);
}

/**
 * Remove the node identified by `nodeId` from its containing object or array
 * (Req 2.2). Re-indexing collapses any array index gap left behind. Rejected
 * with `invalid-target` if `nodeId` is the document root (which has no parent).
 */
export function deleteNode(root: JsonNode, nodeId: string): EditResult {
  const parent = findParent(root, nodeId);
  if (!parent) {
    return {
      ok: false,
      error: { kind: 'invalid-target', message: 'Cannot delete the document root.' },
    };
  }

  const next = transformNode(root, parent.id, (n) => ({
    ...n,
    children: (n.children ?? []).filter((child) => child.id !== nodeId),
  }));
  return finalize(next);
}

/**
 * Rename the key of the object member identified by `nodeId` to `newKey`
 * (Req 2.3). A no-op rename (the same key) is accepted and leaves the document
 * unchanged. Rejected with `duplicate-key` if a *different* sibling already uses
 * `newKey`, leaving the object unchanged (Req 2.5). Rejected with
 * `invalid-target` if the node is not an object member.
 */
export function renameKey(
  root: JsonNode,
  nodeId: string,
  newKey: string,
): EditResult {
  const parent = findParent(root, nodeId);
  const node = findNode(root, nodeId);
  if (!parent || !node || parent.type !== 'object') {
    return {
      ok: false,
      error: { kind: 'invalid-target', message: 'Can only rename an object key.' },
    };
  }

  // Renaming to the current key is a no-op; nothing changes.
  if (String(node.key) === newKey) {
    return finalize(root);
  }

  const conflict = (parent.children ?? []).some(
    (child) => child.id !== nodeId && String(child.key) === newKey,
  );
  if (conflict) {
    return {
      ok: false,
      error: {
        kind: 'duplicate-key',
        conflictingKey: newKey,
        message: `Cannot rename to "${newKey}": it already exists in this object.`,
      },
    };
  }

  const next = transformNode(root, nodeId, (n) => ({ ...n, key: newKey }));
  return finalize(next);
}

/**
 * Replace the value of the scalar node identified by `nodeId` with the scalar
 * carried by `value` (Req 2.4). Rejected with `invalid-target` if either the
 * target or the supplied `value` is not a scalar.
 */
export function setScalar(
  root: JsonNode,
  nodeId: string,
  value: JsonNode,
): EditResult {
  const node = findNode(root, nodeId);
  if (!node || !isScalarType(node.type)) {
    return {
      ok: false,
      error: { kind: 'invalid-target', message: 'Can only edit a scalar value.' },
    };
  }
  if (!isScalarType(value.type)) {
    return {
      ok: false,
      error: { kind: 'invalid-scalar', message: 'The new value must be a JSON scalar.' },
    };
  }

  const next = transformNode(root, nodeId, (n) => ({
    id: n.id,
    key: n.key,
    type: value.type,
    stringValue: value.stringValue,
    numberValue: value.numberValue,
    boolValue: value.boolValue,
  }));
  return finalize(next);
}

// ---------------------------------------------------------------------------
// Text parsing helpers (for the editing UI)
// ---------------------------------------------------------------------------

/**
 * Parse `text` as a JSON *scalar* (string, number, boolean, or null). Returns
 * the parsed scalar node, or `null` when the text is empty or is not a valid
 * JSON scalar (e.g. an object, array, or malformed input) — the rejection
 * condition for Req 2.7.
 */
export function parseScalarText(text: string): JsonNode | null {
  const result = parseJson(text);
  if (result.ok && !result.empty && isScalarType(result.model.type)) {
    return result.model;
  }
  return null;
}

/**
 * Parse `text` as any JSON value (scalar, object, or array). Returns the parsed
 * node, or `null` when the text is empty or invalid. Used to interpret the value
 * a user supplies when adding a new key (Req 2.1).
 */
export function parseValueText(text: string): JsonNode | null {
  const result = parseJson(text);
  if (result.ok && !result.empty) {
    return result.model;
  }
  return null;
}

/**
 * Edit the scalar node identified by `nodeId` from raw `text` input: parse the
 * text as a JSON scalar and, if valid, set the value (Req 2.4). If the text is
 * not a valid JSON scalar the edit is rejected with `invalid-scalar` and the
 * node is left unchanged (Req 2.7).
 */
export function editScalarText(
  root: JsonNode,
  nodeId: string,
  text: string,
): EditResult {
  const value = parseScalarText(text);
  if (value === null) {
    return {
      ok: false,
      error: {
        kind: 'invalid-scalar',
        message: `"${text}" is not a valid JSON scalar.`,
      },
    };
  }
  return setScalar(root, nodeId, value);
}
