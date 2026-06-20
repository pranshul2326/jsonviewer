// Feature: json-viewer-free
//
// Property-based tests for the pure node-edit helpers in `node-edit.ts`
// (addKey / deleteNode / renameKey / setScalar / editScalarText) together with
// `serialize`, `parseJson`, and the `structuralEquals` oracle. Two design
// properties are covered:
//
//   Property 10: Node edits round-trip through the editor text.
//                Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.8
//   Property 11: Invalid node edits are rejected without side effects.
//                Validates: Requirements 2.5, 2.6, 2.7
//
// Inputs are drawn from the shared arbitraries in `src/test/arbitraries.ts`
// (jsonArbitrary, editOperationArbitrary, scalarJsonArbitrary,
// edgyStringArbitrary) so the generators stay biased toward the edge cases the
// properties care about (deep nesting, edge-y keys, big/high-precision numbers).

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import {
  addKey,
  deleteNode,
  renameKey,
  setScalar,
  editScalarText,
  isScalarType,
  type EditResult,
} from './node-edit';
import { serialize } from './serialize';
import { parseJson } from './parse';
import type { JsonNode } from './types';
import {
  jsonArbitrary,
  scalarJsonArbitrary,
  editOperationArbitrary,
  edgyStringArbitrary,
  type EditOperation,
  structuralEquals,
} from '../../test/arbitraries';

// At least 100 iterations per property (design requirement).
const RUNS = { numRuns: 100 } as const;

// ---------------------------------------------------------------------------
// Helpers (reconstruct tree facts independently of the implementation)
// ---------------------------------------------------------------------------

/** Every node in the tree, in pre-order (root first). */
function collectNodes(root: JsonNode): JsonNode[] {
  const out: JsonNode[] = [root];
  if (root.children) {
    for (const child of root.children) out.push(...collectNodes(child));
  }
  return out;
}

/** Map every node id to its parent node (the root maps to `null`). */
function buildParentMap(root: JsonNode): Map<string, JsonNode | null> {
  const map = new Map<string, JsonNode | null>();
  map.set(root.id, null);
  const walk = (node: JsonNode): void => {
    if (node.children) {
      for (const child of node.children) {
        map.set(child.id, node);
        walk(child);
      }
    }
  };
  walk(root);
  return map;
}

/**
 * Parse JSON text and return the model, failing loudly if it was not parsed
 * into a (non-empty) model. The serialized output of any edited model is always
 * non-empty valid JSON, so the empty/error branches here indicate a genuine
 * defect in the edit helpers or serializer.
 */
function parseToModel(text: string): JsonNode {
  const result = parseJson(text);
  if (!result.ok) {
    throw new Error(
      `expected valid JSON but parse failed: ${result.error.message}\n--- text ---\n${text}`,
    );
  }
  if (result.empty) {
    throw new Error(`expected a model but parse reported empty\n--- text ---\n${text}`);
  }
  return result.model;
}

/**
 * Apply a generated {@link EditOperation} to `model` at a compatible target
 * chosen deterministically from `pick`, returning the {@link EditResult}, or
 * `null` when the model offers no valid target for the operation (the property
 * skips those draws). Keys/new-keys are made unique so the operation is a
 * *valid* edit (add-new / rename-to-non-existing), matching Property 10's
 * precondition.
 */
function applyValidEdit(
  model: JsonNode,
  op: EditOperation,
  pick: number,
): EditResult | null {
  const nodes = collectNodes(model);

  switch (op.kind) {
    case 'addKey': {
      const objects = nodes.filter((n) => n.type === 'object');
      if (objects.length === 0) return null;
      const parent = objects[pick % objects.length];
      const existing = new Set((parent.children ?? []).map((c) => String(c.key)));
      // Ensure the key is genuinely new (Req 2.1).
      let key = op.key;
      while (existing.has(key)) key += '_';
      return addKey(model, parent.id, key, op.value);
    }
    case 'delete': {
      const deletable = nodes.filter((n) => n.id !== model.id);
      if (deletable.length === 0) return null;
      const target = deletable[pick % deletable.length];
      return deleteNode(model, target.id); // Req 2.2
    }
    case 'rename': {
      const parentMap = buildParentMap(model);
      const members = nodes.filter((n) => parentMap.get(n.id)?.type === 'object');
      if (members.length === 0) return null;
      const target = members[pick % members.length];
      const parent = parentMap.get(target.id)!;
      const siblingKeys = new Set(
        (parent.children ?? [])
          .filter((c) => c.id !== target.id)
          .map((c) => String(c.key)),
      );
      // Ensure the new name does not already exist on another sibling (Req 2.3).
      let newKey = op.newKey;
      while (siblingKeys.has(newKey)) newKey += '_';
      return renameKey(model, target.id, newKey);
    }
    case 'editScalar': {
      const scalars = nodes.filter((n) => isScalarType(n.type));
      if (scalars.length === 0) return null;
      const target = scalars[pick % scalars.length];
      return setScalar(model, target.id, op.value); // Req 2.4
    }
  }
}

// ---------------------------------------------------------------------------
// Property 10: Node edits round-trip through the editor text
// ---------------------------------------------------------------------------

describe('Property 10: Node edits round-trip through the editor text (Req 2.1, 2.2, 2.3, 2.4, 2.8)', () => {
  // Feature: json-viewer-free, Property 10: For any valid model and any valid
  // edit operation (add a new key, delete a node, rename a key to a non-existing
  // name, or edit a scalar to a valid scalar), applying the operation via the
  // node-edit helpers and re-parsing the serialized editor text yields a model
  // equal to the directly-mutated model. Validates: Requirements 2.1, 2.2, 2.3,
  // 2.4, 2.8.
  test.prop([jsonArbitrary(), editOperationArbitrary(), fc.nat()], RUNS)(
    'applying a valid edit and re-parsing its serialized text equals the edited model',
    (model, op, pick) => {
      const result = applyValidEdit(model, op, pick);

      // No compatible target for this operation in this model — skip the draw.
      fc.pre(result !== null);

      // A valid edit must succeed.
      if (!result!.ok) {
        throw new Error(
          `expected a valid ${op.kind} edit to succeed but it was rejected: ${JSON.stringify(
            result!.error,
          )}`,
        );
      }

      const edited = result!.model;

      // Round-trip: the serialized editor text re-parses to the same model the
      // helper produced directly (Req 2.8).
      const reparsed = parseToModel(serialize(edited));
      if (!structuralEquals(edited, reparsed)) {
        throw new Error(
          `${op.kind} edit did not round-trip through serialize/parse\n--- serialized ---\n${serialize(
            edited,
          )}`,
        );
      }
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Property 11: Invalid node edits are rejected without side effects
// ---------------------------------------------------------------------------

/** A textual rendering of any valid JSON value (used as add/rename values). */
const jsonValueTextArbitrary = jsonArbitrary().map(serialize);

/**
 * An object model with at least `minMembers` uniquely-keyed members. Built by
 * parsing assembled text so ids/keys match exactly what the parser produces.
 */
function objectModelArbitrary(minMembers: number): fc.Arbitrary<JsonNode> {
  return fc
    .uniqueArray(fc.tuple(edgyStringArbitrary(), jsonValueTextArbitrary), {
      selector: (entry) => entry[0],
      minLength: minMembers,
      maxLength: 6,
    })
    .map((entries) => {
      const text = `{${entries
        .map(([key, valueText]) => `${JSON.stringify(key)}:${valueText}`)
        .join(',')}}`;
      const result = parseJson(text);
      if (!result.ok || result.empty) {
        throw new Error(`failed to build object model from: ${text}`);
      }
      return result.model;
    });
}

/**
 * Text that is NOT a valid JSON scalar: malformed fragments, non-scalar
 * literals, and the serialized form of any object/array value (valid JSON, but
 * not a scalar). Every draw causes `editScalarText` to reject (Req 2.7).
 */
const invalidScalarTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '',
    '   ',
    '{',
    '}',
    '[',
    ']',
    'undefined',
    'abc',
    'NaN',
    'tru',
    '+1',
    '01',
    '1 2',
    '1,2',
    '{"k":1',
    "'x'",
  ),
  // Serialized objects/arrays: valid JSON, but never a scalar.
  jsonArbitrary()
    .filter((m) => m.type === 'object' || m.type === 'array')
    .map(serialize),
);

describe('Property 11: Invalid node edits are rejected without side effects (Req 2.5, 2.6, 2.7)', () => {
  // Feature: json-viewer-free, Property 11 (rename conflict): Renaming one key
  // to another key that already exists in the same object is rejected with a
  // duplicate-key error naming the conflicting key, and the object is left
  // unchanged. Validates: Requirements 2.5.
  test.prop([objectModelArbitrary(2), fc.nat(), fc.nat()], RUNS)(
    'renaming a key to an existing sibling key is rejected and the object is unchanged',
    (obj, i, j) => {
      const members = obj.children!;
      const keysBefore = members.map((c) => String(c.key));

      const a = i % members.length;
      let b = j % members.length;
      if (b === a) b = (b + 1) % members.length; // a distinct sibling
      const target = members[a];
      const conflictingKey = String(members[b].key);

      const result = renameKey(obj, target.id, conflictingKey);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('duplicate-key');
        expect(result.error.conflictingKey).toBe(conflictingKey);
      }
      // The pure helper produces no new model; the original object's keys (and
      // their order) are untouched (Req 2.5).
      expect(obj.children!.map((c) => String(c.key))).toEqual(keysBefore);
      return true;
    },
  );

  // Feature: json-viewer-free, Property 11 (add conflict): Adding a key that
  // already exists in the object is rejected with a duplicate-key error naming
  // the conflicting key, and the object is left unchanged. Validates:
  // Requirements 2.6.
  test.prop([objectModelArbitrary(1), jsonArbitrary(), fc.nat()], RUNS)(
    'adding a key that already exists is rejected and the object is unchanged',
    (obj, value, i) => {
      const members = obj.children!;
      const keysBefore = members.map((c) => String(c.key));
      const conflictingKey = String(members[i % members.length].key);

      const result = addKey(obj, obj.id, conflictingKey, value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('duplicate-key');
        expect(result.error.conflictingKey).toBe(conflictingKey);
      }
      // Object membership is unchanged (Req 2.6).
      expect(obj.children!.length).toBe(members.length);
      expect(obj.children!.map((c) => String(c.key))).toEqual(keysBefore);
      return true;
    },
  );

  // Feature: json-viewer-free, Property 11 (invalid scalar): Editing a scalar
  // node's value to text that is not a valid JSON scalar is rejected with an
  // invalid-scalar error and the node is left unchanged. Validates: Requirements
  // 2.7.
  test.prop([scalarJsonArbitrary(), invalidScalarTextArbitrary], RUNS)(
    'editing a scalar to an invalid value is rejected and the node is unchanged',
    (scalar, text) => {
      const before = serialize(scalar);

      const result = editScalarText(scalar, scalar.id, text);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('invalid-scalar');
      }
      // The pure helper produces no new model; the scalar node is unchanged
      // (Req 2.7).
      expect(serialize(scalar)).toBe(before);
      return true;
    },
  );
});
