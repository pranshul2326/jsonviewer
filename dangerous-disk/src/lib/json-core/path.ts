// Feature: json-viewer-free
//
// JSON path computation for the pure `json-core` library:
//
//   nodePath(model, nodeId)    : JsonNode -> PathSegment[] | undefined
//   dotPath(model, nodeId)     : JsonNode -> dot-notation JSON_Path string
//   bracketPath(model, nodeId) : JsonNode -> bracket-notation JSON_Path string
//   resolvePath(model, path)   : (JsonNode, string) -> JsonNode | undefined
//
// A JSON_Path addresses a node relative to the document root. We model a path
// as an ordered array of {@link PathSegment}s — one per step down the tree —
// where each step is either an object *key* or an array *index*. Computing a
// node's segments is a single tree walk; rendering them to a string then
// applies the notation-specific rules below.
//
// Dot-notation (Req 4.1, 4.5):
//   - an array index renders as a bracketed integer, e.g. `[0]`;
//   - an object key renders as a dot-prefixed segment (`.name`, or just `name`
//     at the start) only when it is a *safe identifier* — non-empty, composed
//     solely of ASCII letters, digits, and underscore, and not beginning with a
//     digit; otherwise it renders as a bracketed quoted segment, e.g. `["a b"]`.
//
// Bracket-notation (Req 4.2):
//   - every array index renders as a bracketed integer, e.g. `[0]`;
//   - every object key renders as a bracketed quoted string, e.g. `["name"]`.
//
// `resolvePath` is the inverse used to verify path-correctness (Req 4.6): it
// parses either notation (mixed dot/bracket, double- or single-quoted keys,
// optional leading `$`) back into segments and walks the model to the addressed
// node. For any node, `resolvePath(model, dotPath(model, id))` and
// `resolvePath(model, bracketPath(model, id))` both return that node.

import type { JsonNode } from './types';

/**
 * A single step in a JSON_Path:
 *   - `{ kind: 'key', key }`   — descend into an object member by name,
 *   - `{ kind: 'index', index }` — descend into an array element by position.
 */
export type PathSegment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number };

/**
 * The safe-identifier rule for dot-notation keys (Req 4.5): a non-empty key
 * containing only ASCII letters, digits, and underscore, and not beginning with
 * a digit. Such keys may be written as a dot-prefixed segment; all other keys
 * must be bracketed and quoted.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `key` may be rendered as a dot-prefixed segment (Req 4.5). */
export function isSafeIdentifier(key: string): boolean {
  return SAFE_IDENTIFIER.test(key);
}

/** The path segment that descends from a parent into the given child node. */
function segmentForChild(child: JsonNode): PathSegment {
  return typeof child.key === 'number'
    ? { kind: 'index', index: child.key }
    : { kind: 'key', key: String(child.key) };
}

/**
 * Compute the path of the node identified by `nodeId`, as an ordered array of
 * segments from the document root (exclusive) down to the node (inclusive).
 *
 * Returns an empty array when `nodeId` is the root node itself, and `undefined`
 * when no node with that id exists in `model`.
 */
export function nodePath(
  model: JsonNode,
  nodeId: string,
): PathSegment[] | undefined {
  const walk = (
    node: JsonNode,
    acc: PathSegment[],
  ): PathSegment[] | undefined => {
    if (node.id === nodeId) {
      return acc;
    }
    if (node.children) {
      for (const child of node.children) {
        const found = walk(child, [...acc, segmentForChild(child)]);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };

  return walk(model, []);
}

/** Render path segments as a dot-notation JSON_Path string (Req 4.1, 4.5). */
export function formatDotPath(segments: readonly PathSegment[]): string {
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'index') {
      out += `[${seg.index}]`;
    } else if (isSafeIdentifier(seg.key)) {
      // Dot-prefixed, except for the very first segment of the path.
      out += out === '' ? seg.key : `.${seg.key}`;
    } else {
      // Unsafe (or empty) key: bracketed, double-quoted, JSON-escaped.
      out += `[${JSON.stringify(seg.key)}]`;
    }
  }
  return out;
}

/** Render path segments as a bracket-notation JSON_Path string (Req 4.2). */
export function formatBracketPath(segments: readonly PathSegment[]): string {
  let out = '';
  for (const seg of segments) {
    out +=
      seg.kind === 'index'
        ? `[${seg.index}]`
        : `[${JSON.stringify(seg.key)}]`;
  }
  return out;
}

/**
 * Compute the dot-notation JSON_Path of the node identified by `nodeId`,
 * beginning at the document root (Req 4.1, 4.5).
 *
 * Returns `''` for the root node itself. Throws when `nodeId` does not identify
 * any node in `model`.
 */
export function dotPath(model: JsonNode, nodeId: string): string {
  const segments = nodePath(model, nodeId);
  if (segments === undefined) {
    throw new Error(`No node with id "${nodeId}" in the document`);
  }
  return formatDotPath(segments);
}

/**
 * Compute the bracket-notation JSON_Path of the node identified by `nodeId`,
 * beginning at the document root, where every array index is a bracketed
 * integer and every object key is a bracketed quoted string (Req 4.2).
 *
 * Returns `''` for the root node itself. Throws when `nodeId` does not identify
 * any node in `model`.
 */
export function bracketPath(model: JsonNode, nodeId: string): string {
  const segments = nodePath(model, nodeId);
  if (segments === undefined) {
    throw new Error(`No node with id "${nodeId}" in the document`);
  }
  return formatBracketPath(segments);
}

/** Decode a JSON-style string escape sequence starting at `text[i]` (the `\`). */
function decodeEscape(
  text: string,
  i: number,
): { value: string; next: number } {
  const next = text[i + 1];
  switch (next) {
    case '"':
      return { value: '"', next: i + 2 };
    case "'":
      return { value: "'", next: i + 2 };
    case '\\':
      return { value: '\\', next: i + 2 };
    case '/':
      return { value: '/', next: i + 2 };
    case 'b':
      return { value: '\b', next: i + 2 };
    case 'f':
      return { value: '\f', next: i + 2 };
    case 'n':
      return { value: '\n', next: i + 2 };
    case 'r':
      return { value: '\r', next: i + 2 };
    case 't':
      return { value: '\t', next: i + 2 };
    case 'u': {
      const hex = text.slice(i + 2, i + 6);
      return {
        value: String.fromCharCode(Number.parseInt(hex, 16)),
        next: i + 6,
      };
    }
    default:
      // Unknown escape: keep the following character verbatim.
      return { value: next ?? '', next: i + 2 };
  }
}

/**
 * Read a quoted key starting just after the opening `quote` at `text[start]`.
 * Returns the decoded key value and the index just past the closing quote, or
 * `undefined` if the literal is unterminated.
 */
function readQuoted(
  text: string,
  start: number,
  quote: string,
): { value: string; next: number } | undefined {
  let value = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const decoded = decodeEscape(text, i);
      value += decoded.value;
      i = decoded.next;
    } else if (ch === quote) {
      return { value, next: i + 1 };
    } else {
      value += ch;
      i += 1;
    }
  }
  return undefined;
}

/**
 * Parse a JSON_Path string into segments. Accepts mixed dot- and
 * bracket-notation, an optional leading `$` root marker, bare or dot-prefixed
 * identifier keys, double- or single-quoted bracketed keys, and bracketed
 * integer indices. Returns `undefined` for malformed input.
 */
export function parsePath(path: string): PathSegment[] | undefined {
  const segments: PathSegment[] = [];
  const n = path.length;
  let i = 0;

  // Optional leading root marker.
  if (path[i] === '$') {
    i += 1;
  }

  while (i < n) {
    const ch = path[i];

    if (ch === '.') {
      // Dot-prefixed identifier key.
      i += 1;
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(path[i])) {
        i += 1;
      }
      if (i === start) {
        return undefined; // a dot with no following identifier
      }
      segments.push({ kind: 'key', key: path.slice(start, i) });
    } else if (ch === '[') {
      i += 1;
      if (i >= n) {
        return undefined;
      }
      const quote = path[i];
      if (quote === '"' || quote === "'") {
        const read = readQuoted(path, i + 1, quote);
        if (!read || path[read.next] !== ']') {
          return undefined;
        }
        segments.push({ kind: 'key', key: read.value });
        i = read.next + 1;
      } else {
        // Bracketed integer index.
        const start = i;
        while (i < n && path[i] !== ']') {
          i += 1;
        }
        if (i >= n) {
          return undefined; // missing closing bracket
        }
        const inner = path.slice(start, i).trim();
        if (!/^\d+$/.test(inner)) {
          return undefined; // not a non-negative integer index
        }
        segments.push({ kind: 'index', index: Number.parseInt(inner, 10) });
        i += 1; // consume ']'
      }
    } else if (/[A-Za-z_$]/.test(ch)) {
      // Bare leading identifier (dot-notation's first segment, no leading dot).
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(path[i])) {
        i += 1;
      }
      segments.push({ kind: 'key', key: path.slice(start, i) });
    } else {
      return undefined; // unexpected character
    }
  }

  return segments;
}

/** Walk `model` along `segments`, returning the addressed node if it exists. */
export function resolveSegments(
  model: JsonNode,
  segments: readonly PathSegment[],
): JsonNode | undefined {
  let current: JsonNode | undefined = model;
  for (const seg of segments) {
    if (current === undefined) {
      return undefined;
    }
    if (seg.kind === 'index') {
      if (current.type !== 'array' || !current.children) {
        return undefined;
      }
      current = current.children[seg.index];
    } else {
      if (current.type !== 'object' || !current.children) {
        return undefined;
      }
      current = current.children.find((child) => String(child.key) === seg.key);
    }
  }
  return current;
}

/**
 * Evaluate a JSON_Path string against the document model and return the
 * addressed node, or `undefined` if the path is malformed or does not resolve
 * (Req 4.6). Used to verify the path-correctness property: a path produced by
 * {@link dotPath} or {@link bracketPath} resolves to exactly its node.
 */
export function resolvePath(
  model: JsonNode,
  path: string,
): JsonNode | undefined {
  const segments = parsePath(path);
  if (segments === undefined) {
    return undefined;
  }
  return resolveSegments(model, segments);
}
