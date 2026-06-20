// Feature: json-viewer-free
//
// Property-based tests for RFC 6902 JSON Patch generation (`patch.ts`):
//   - Property 18: JSON Patch conformance (Req 10.1)
//   - Property 19: Patch-correctness (Req 10.2, 10.3)
//
// Both properties draw their input documents from the shared `jsonArbitrary`
// in `src/test/arbitraries.ts`. To exercise the interesting (non-empty) patch
// space we feed `toJsonPatch` two *independently generated* documents per run,
// and we additionally seed structurally-equivalent pairs (a document against a
// key-reordered copy of itself) so the empty-patch guarantee (Req 10.3) is
// covered.
//
// The reference applier is `fast-json-patch.applyPatch`, exactly as the design
// specifies. Correctness is checked through the shared `structuralEquals`
// oracle: applying the produced patch to the left document must yield a result
// structurally equivalent to the right document.

import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { applyPatch, type Operation } from 'fast-json-patch';

import type { JsonNode } from './types';
import { toJsonPatch, type JsonPatchOperation } from './patch';
import { jsonArbitrary, structuralEquals } from '../../test/arbitraries';

const ROOT_ID = '$';

/** Build a stable child id mirroring the model's `childId`. */
function childId(parentId: string, key: string | number): string {
  return `${parentId}/${encodeURIComponent(String(key))}`;
}

/**
 * Project a `JsonNode` tree into a plain JS value tree, mirroring the same
 * lossy-number projection `patch.ts` uses internally (`Number(lexeme)`). Both
 * the left and right documents pass through this identical projection, so any
 * precision loss is symmetric and never produces a spurious mismatch.
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
      const result: { [key: string]: unknown } = {};
      for (const child of node.children ?? []) {
        result[String(child.key)] = toPlain(child);
      }
      return result;
    }
    default:
      return null;
  }
}

/**
 * Reconstruct a `JsonNode` tree from a plain JS value so the patched result can
 * be compared against the right document through the `structuralEquals` oracle.
 * Numbers are carried back as their `String(...)` lexeme (the oracle normalizes
 * numeric lexemes, so `1` and `1.0` still compare equal).
 */
function fromPlain(
  value: unknown,
  key: string | number | null = null,
  id: string = ROOT_ID,
): JsonNode {
  if (value === null || value === undefined) {
    return { id, key, type: 'null' };
  }
  switch (typeof value) {
    case 'boolean':
      return { id, key, type: 'boolean', boolValue: value };
    case 'string':
      return { id, key, type: 'string', stringValue: value };
    case 'number':
    case 'bigint':
      return { id, key, type: 'number', numberValue: String(value) };
    default:
      break;
  }
  if (Array.isArray(value)) {
    return {
      id,
      key,
      type: 'array',
      children: value.map((item, index) =>
        fromPlain(item, index, childId(id, index)),
      ),
    };
  }
  const obj = value as { [k: string]: unknown };
  return {
    id,
    key,
    type: 'object',
    children: Object.keys(obj).map((propKey) =>
      fromPlain(obj[propKey], propKey, childId(id, propKey)),
    ),
  };
}

/** Return a structurally-equivalent copy of `node` with object keys reversed. */
function reorderKeys(node: JsonNode): JsonNode {
  switch (node.type) {
    case 'array':
      return {
        ...node,
        children: (node.children ?? []).map((child) => reorderKeys(child)),
      };
    case 'object':
      return {
        ...node,
        children: [...(node.children ?? [])]
          .reverse()
          .map((child) => reorderKeys(child)),
      };
    default:
      return node;
  }
}

/** The set of own member-field names a conformant operation must carry. */
function expectedFields(op: JsonPatchOperation['op']): Set<string> {
  switch (op) {
    case 'add':
    case 'replace':
    case 'test':
      return new Set(['op', 'path', 'value']);
    case 'remove':
      return new Set(['op', 'path']);
    case 'move':
    case 'copy':
      return new Set(['op', 'path', 'from']);
  }
}

const VALID_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

describe('Property 18: JSON Patch conformance (Req 10.1)', () => {
  // For any pair of valid JSON documents, every element of the produced patch
  // is a well-formed RFC 6902 operation: a recognized `op`, a string `path`,
  // and exactly the member fields that operation requires — no more, no less.
  test.prop([jsonArbitrary(), jsonArbitrary()], { numRuns: 100 })(
    'every produced operation is a well-formed RFC 6902 op',
    (left, right) => {
      const patch = toJsonPatch(left, right);

      for (const operation of patch) {
        // `op` is one of the six RFC 6902 operations.
        expect(VALID_OPS.has(operation.op)).toBe(true);

        // `path` is a JSON Pointer string.
        expect(typeof operation.path).toBe('string');

        // The operation carries exactly the member fields it requires.
        const actualFields = new Set(Object.keys(operation));
        const required = expectedFields(operation.op);
        expect(actualFields).toEqual(required);
      }
      return true;
    },
  );
});

describe('Property 19: Patch-correctness (Req 10.2, 10.3)', () => {
  // For any pair of valid JSON documents, applying the produced patch to the
  // left document yields a document structurally equivalent to the right.
  test.prop([jsonArbitrary(), jsonArbitrary()], { numRuns: 100 })(
    'applying the patch to left yields a document equivalent to right',
    (left, right) => {
      const patch = toJsonPatch(left, right);

      // Apply the patch with the reference applier against a plain projection
      // of the left document (mutateDocument = false → returns newDocument).
      const applied = applyPatch(
        toPlain(left),
        patch as Operation[],
        false,
        false,
      ).newDocument;

      const result = fromPlain(applied);
      const expected = fromPlain(toPlain(right));

      expect(structuralEquals(result, expected)).toBe(true);
      return true;
    },
  );

  // When the two documents are structurally equivalent, the produced patch is
  // the empty array (length 0).
  test.prop([jsonArbitrary()], { numRuns: 100 })(
    'structurally equivalent documents produce the empty patch',
    (model) => {
      const copy = reorderKeys(model);
      // Sanity: the reordered copy really is structurally equivalent.
      expect(structuralEquals(model, copy)).toBe(true);

      expect(toJsonPatch(model, copy)).toEqual([]);
      return true;
    },
  );

  it('produces a non-empty, correct patch for a simple scalar change', () => {
    const left: JsonNode = {
      id: ROOT_ID,
      key: null,
      type: 'object',
      children: [{ id: '$/a', key: 'a', type: 'number', numberValue: '1' }],
    };
    const right: JsonNode = {
      id: ROOT_ID,
      key: null,
      type: 'object',
      children: [{ id: '$/a', key: 'a', type: 'number', numberValue: '2' }],
    };

    const patch = toJsonPatch(left, right);
    expect(patch.length).toBeGreaterThan(0);

    const applied = applyPatch(toPlain(left), patch as Operation[], false, false)
      .newDocument;
    expect(structuralEquals(fromPlain(applied), right)).toBe(true);
  });
});
