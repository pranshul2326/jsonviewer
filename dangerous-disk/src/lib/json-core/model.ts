// Feature: json-viewer-free
//
// The `JsonNode` data model and the converters that bridge it to/from the
// value tree produced by `lossless-json`.
//
//   fromLossless(value) : LosslessValue -> JsonNode
//   toLossless(node)    : JsonNode      -> LosslessValue
//
// Both directions preserve:
//   - object key order (children are an ordered array, walked in source order),
//   - array element order,
//   - numeric precision (numbers carry their raw lexeme verbatim).
//
// `toLossless` returns a value suitable for `lossless-json`'s `stringify` and
// for libraries such as `fast-json-patch`. (Serialization that must preserve
// integer-like object key order emits text directly from the ordered `children`
// array in `serialize.ts`, since plain JS objects cannot preserve such order.)

import { LosslessNumber, isLosslessNumber } from 'lossless-json';
import type { Node as JsoncNode } from 'jsonc-parser';
import type { JsonNode, LosslessValue } from './types';

export type { JsonNode, JsonType, LosslessValue } from './types';

/** Id of the document root node. */
const ROOT_ID = '$';

/**
 * Build a stable, unique id for a child node from its parent's id and its key.
 * The key is encoded so that ids remain unique regardless of key contents.
 */
function childId(parentId: string, key: string | number): string {
  return `${parentId}/${encodeURIComponent(String(key))}`;
}

/**
 * Assign `value` to `key` as an *own, enumerable data property* of `target`.
 *
 * Plain assignment (`target[key] = value`) is unsafe for keys that collide with
 * accessors inherited from `Object.prototype` — most notably `__proto__`, whose
 * inherited setter reinterprets the assignment as a prototype change rather than
 * storing a data member, silently dropping the key (and risking prototype
 * pollution). `Object.defineProperty` bypasses inherited accessors, so any key —
 * including `__proto__`, `constructor`, and `prototype` — is preserved as an
 * ordinary data member that round-trips faithfully. (Mirrors the same helper in
 * `converters/shared.ts`.)
 */
export function assignDataKey(
  target: { [key: string]: unknown },
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Extract the raw numeric lexeme from a value that `lossless-json` produced for
 * a JSON number. Handles `LosslessNumber` (the default), as well as native
 * `number`/`bigint` in case a caller supplied a plain value tree.
 */
function numberLexeme(value: unknown): string {
  if (isLosslessNumber(value)) {
    return value.value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  // Native number fallback (precision is whatever the caller already has).
  return String(value);
}

/**
 * Convert a `lossless-json` value tree into a `JsonNode` tree.
 *
 * @param value  The output of `lossless-json`'s `parse` (or an equivalent
 *               value tree). Numbers are expected as `LosslessNumber`.
 * @param key    The node's key relative to its parent (omit/`null` for root).
 * @param id     The node's stable id (defaults to the root id for the root).
 */
export function fromLossless(
  value: LosslessValue,
  key: string | number | null = null,
  id: string = ROOT_ID,
): JsonNode {
  // null
  if (value === null) {
    return { id, key, type: 'null' };
  }

  const valueType = typeof value;

  // string
  if (valueType === 'string') {
    return { id, key, type: 'string', stringValue: value as string };
  }

  // boolean
  if (valueType === 'boolean') {
    return { id, key, type: 'boolean', boolValue: value as boolean };
  }

  // number (LosslessNumber, bigint, or native number)
  if (
    isLosslessNumber(value) ||
    valueType === 'number' ||
    valueType === 'bigint'
  ) {
    return { id, key, type: 'number', numberValue: numberLexeme(value) };
  }

  // array — preserve element order
  if (Array.isArray(value)) {
    const children = value.map((element, index) =>
      fromLossless(element, index, childId(id, index)),
    );
    return { id, key, type: 'array', children };
  }

  // object — preserve key order as given by the source value tree
  const obj = value as { [k: string]: LosslessValue };
  const children = Object.keys(obj).map((propKey) =>
    fromLossless(obj[propKey], propKey, childId(id, propKey)),
  );
  return { id, key, type: 'object', children };
}

/**
 * Convert a `jsonc-parser` concrete-syntax-tree `Node` into a `JsonNode` tree.
 *
 * Unlike `fromLossless`, this never funnels object members through a plain JS
 * object: a `jsonc-parser` object node carries its members as an ordered array
 * of `property` nodes whose key is a string *value*, so object keys that
 * collide with `Object.prototype` accessors — `__proto__`, `constructor`,
 * `prototype`, `hasOwnProperty`, … — are preserved faithfully (the `JsonNode`
 * model itself stores members as an ordered `children` array, never an object
 * map). This is the structure-of-record for parsing (`parse.ts`).
 *
 * Numeric precision is preserved by re-reading the raw source lexeme via the
 * node's `offset`/`length` (the node's pre-parsed `value` is a lossy JS
 * `number`), matching the verbatim lexeme `lossless-json` would have produced.
 *
 * @param node  A `jsonc-parser` value node (object/array/string/number/
 *              boolean/null). `property` nodes are consumed within `object`.
 * @param text  The original source text, used to slice raw number lexemes.
 * @param key   The node's key relative to its parent (omit/`null` for root).
 * @param id    The node's stable id (defaults to the root id for the root).
 */
export function fromJsoncTree(
  node: JsoncNode,
  text: string,
  key: string | number | null = null,
  id: string = ROOT_ID,
): JsonNode {
  switch (node.type) {
    case 'null':
      return { id, key, type: 'null' };
    case 'string':
      return { id, key, type: 'string', stringValue: String(node.value ?? '') };
    case 'boolean':
      return { id, key, type: 'boolean', boolValue: Boolean(node.value) };
    case 'number':
      // Slice the verbatim source lexeme so big integers and high-precision
      // decimals survive (node.value would be a lossy JS number).
      return {
        id,
        key,
        type: 'number',
        numberValue: text.slice(node.offset, node.offset + node.length),
      };
    case 'array': {
      const children = (node.children ?? []).map((child, index) =>
        fromJsoncTree(child, text, index, childId(id, index)),
      );
      return { id, key, type: 'array', children };
    }
    case 'object': {
      // Each child is a `property` node: children[0] is the key string node,
      // children[1] is the value node. The key lives as a string value, so no
      // prototype-colliding object map is ever built.
      const children = (node.children ?? []).map((property) => {
        const propChildren = property.children ?? [];
        const propKey = String(propChildren[0]?.value ?? '');
        const valueNode = propChildren[1];
        return fromJsoncTree(valueNode as JsoncNode, text, propKey, childId(id, propKey));
      });
      return { id, key, type: 'object', children };
    }
    default:
      throw new Error(`Unsupported jsonc node type: ${String(node.type)}`);
  }
}

/**
 * Convert a `JsonNode` tree back into a `lossless-json` value tree.
 *
 * Numbers are reconstructed as `LosslessNumber` instances from their raw
 * lexeme, so the original precision is re-emitted verbatim by `stringify`.
 */
export function toLossless(node: JsonNode): LosslessValue {
  switch (node.type) {
    case 'null':
      return null;
    case 'string':
      return node.stringValue ?? '';
    case 'boolean':
      return node.boolValue ?? false;
    case 'number':
      return new LosslessNumber(node.numberValue ?? '0') as unknown as LosslessValue;
    case 'array':
      return (node.children ?? []).map((child) => toLossless(child));
    case 'object': {
      const result: { [key: string]: LosslessValue } = {};
      for (const child of node.children ?? []) {
        // Prototype-safe assignment so object keys that collide with
        // `Object.prototype` accessors (e.g. `__proto__`) round-trip as own
        // data members instead of mutating the prototype.
        assignDataKey(result, String(child.key), toLossless(child));
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
