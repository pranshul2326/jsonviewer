// Feature: json-viewer-free
//
// RFC 6902 JSON Patch generation for the pure `json-core` library.
//
//   toJsonPatch(left, right) : (JsonNode, JsonNode) -> JsonPatchOperation[]
//
// The patch describes the changes that transform `left` into `right` as an
// array of RFC 6902 operations. Generation is delegated to
// `fast-json-patch`'s `compare()`, which emits a minimal, spec-conformant
// add/remove/replace patch (Req 10.1).
//
// Why a plain-value projection?
//   `compare()` performs a structural deep-equality walk over two plain JS
//   value trees and re-emits affected values inside the patch. The `JsonNode`
//   model carries numbers as their raw lexeme string (`numberValue`), and
//   `toLossless` reconstructs them as `LosslessNumber` instances — neither of
//   which `compare()` treats as a plain, comparable scalar. We therefore
//   project the tree to plain JS values (native numbers, strings, booleans,
//   null, arrays, and ordinary objects) before diffing. Number lexemes are
//   converted with `Number(...)`, so values that are numerically equal compare
//   equal (e.g. `1.0` and `1`, `1e2` and `100`) and do not produce spurious
//   `replace` operations, and the emitted patch values are ordinary JSON
//   scalars that serialize cleanly.
//
// Structural-equivalence guarantee (Req 10.3):
//   When `left` and `right` are structurally equivalent (per the shared
//   `structuralEquals` oracle — equal object members irrespective of key order,
//   equal array elements in order, and numerically-equal scalars), this returns
//   the empty array. The check is made against the oracle directly so the
//   guarantee holds regardless of any incidental projection details.

// `fast-json-patch` is published as a CommonJS module, so Node's ESM loader
// (used during Astro's static prerender) cannot bind its named exports
// directly. Import the module's default (its `module.exports`) and read
// `compare` off it — this interop works under Node ESM SSR, the Vite client
// bundle, and the worker bundle alike.
import fastJsonPatch from 'fast-json-patch';
import { structuralEquals } from './canonical';
import { assignDataKey } from './model';
import type { JsonNode } from './types';

const { compare } = fastJsonPatch;

/**
 * A single RFC 6902 JSON Patch operation.
 *
 * Each operation carries exactly the member fields required by its `op`:
 *   - `add` / `replace` / `test` — `path` and `value`,
 *   - `remove` — `path`,
 *   - `move` / `copy` — `path` and `from`.
 *
 * `fast-json-patch`'s `compare()` emits only `add`, `remove`, and `replace`,
 * but the full RFC 6902 operation set is modeled here so the type also
 * describes patches produced or consumed elsewhere.
 */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  /** JSON Pointer (RFC 6901) locating the target of the operation. */
  path: string;
  /** Present for `add`, `replace`, and `test`. */
  value?: unknown;
  /** Present for `move` and `copy`: the JSON Pointer of the source. */
  from?: string;
}

/** Alias matching the interface name used in the design document. */
export type JsonPatchOp = JsonPatchOperation;

/**
 * Project a `JsonNode` tree into a plain JS value tree suitable for
 * `fast-json-patch`'s `compare()`. Numbers are converted to native JS numbers;
 * object key order and array order are preserved.
 */
function toPlainValue(node: JsonNode): unknown {
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
      return (node.children ?? []).map((child) => toPlainValue(child));
    case 'object': {
      const result: { [key: string]: unknown } = {};
      for (const child of node.children ?? []) {
        // Prototype-safe assignment so keys like `__proto__` project to own
        // data members `compare()` can diff, rather than mutating the prototype.
        assignDataKey(result, String(child.key), toPlainValue(child));
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

/**
 * Classify a projected plain value's root as a container kind that
 * `fast-json-patch`'s `compare()` can diff member-by-member, or `'scalar'`
 * for roots it cannot (strings, numbers, booleans, and `null`). `compare()`
 * only produces a correct diff when both roots share the same container kind
 * (`'object'` vs `'object'` or `'array'` vs `'array'`); a scalar root, or a
 * mismatched object-vs-array pair, requires a whole-document `replace`.
 */
function rootKind(value: unknown): 'object' | 'array' | 'scalar' {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object' && value !== null) {
    return 'object';
  }
  return 'scalar';
}

/**
 * Produce an RFC 6902 JSON Patch that transforms `left` into `right`.
 *
 * Returns the empty array when `left` and `right` are structurally equivalent
 * (Req 10.3); otherwise returns the minimal patch computed by
 * `fast-json-patch`'s `compare()` (Req 10.1).
 */
export function toJsonPatch(left: JsonNode, right: JsonNode): JsonPatchOperation[] {
  // Structural equivalence short-circuit: equivalent documents yield no patch,
  // irrespective of object key ordering, whitespace, or number lexeme form.
  if (structuralEquals(left, right)) {
    return [];
  }

  const leftValue = toPlainValue(left);
  const rightValue = toPlainValue(right);

  // RFC 6902 root-document handling. `fast-json-patch`'s `compare()` only
  // diffs two roots of the *same* container kind (object-vs-object or
  // array-vs-array): a scalar/null root makes it throw (left scalar) or
  // silently return an incorrect empty patch (right scalar), and a mismatched
  // object-vs-array pair yields an incorrect diff (e.g. {} vs [] produces an
  // empty patch). In any of these cases the documents cannot be diffed
  // member-by-member, so the whole document is replaced with a single
  // `replace` operation at the root pointer "" carrying the right value
  // (op="replace", path="", value=<right>). The structuralEquals short-circuit
  // above has already ruled out the equivalent case.
  const leftKind = rootKind(leftValue);
  const rightKind = rootKind(rightValue);
  if (leftKind === 'scalar' || rightKind === 'scalar' || leftKind !== rightKind) {
    return [{ op: 'replace', path: '', value: rightValue }];
  }

  const patch = compare(leftValue as object, rightValue as object);

  return patch as JsonPatchOperation[];
}
