// Feature: json-viewer-free
//
// Property test for the JSON ↔ TOML converter in `toml.ts` (Req 13.5, 13.6, 13.8).
//
//   - Property 24: TOML round-trip  (Req 13.5, 13.6, 13.8)
//
// The round-trip pipeline mirrors the application's use of the converter:
//
//   JsonNode --serialize--> JSON text --jsonToToml--> TOML text
//            --tomlToJson--> JSON text --parseJson--> JsonNode'
//
// and asserts the original and recovered models are structurally and value-wise
// identical under `structuralEquals` (ignoring insignificant key ordering and
// comparing numbers by value).
//
// Domain note (converter contract, see toml.ts header): TOML's top level is
// always a table, it has no null type, and `smol-toml`'s parser rejects any
// integer it cannot represent losslessly as a JS number (i.e. outside the
// safe-integer range). The converter additionally treats empty input as "no
// TOML to convert", so an empty root table cannot round-trip. We therefore draw
// from a generator constrained to TOML's documented representable domain — a
// **non-empty object root, no null values anywhere, and numbers that are either
// safe integers or non-integer finite doubles** — rather than weakening the
// equivalence assertion. Strings and number lexemes are still drawn from the
// shared edge-y scalar arbitraries so the full value space TOML *can* represent
// is exercised.

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from '../json-core/types';
import { parseJson } from '../json-core/parse';
import { serialize } from '../json-core/serialize';
import {
  edgyStringArbitrary,
  numberLexemeArbitrary,
  structuralEquals,
} from '../../test/arbitraries';
import { jsonToToml, tomlToJson } from './toml';

/**
 * A number lexeme in TOML's round-trippable numeric domain: every value is a
 * finite double that is either a safe integer or a non-integer (TOML floats are
 * doubles). Integers outside the safe-integer range are excluded because
 * `smol-toml`'s parser rejects integers it cannot represent losslessly. Each
 * kept value is emitted in its canonical double form so the model number is
 * exactly the double that survives the round-trip.
 */
function doubleSafeNumberLexemeArbitrary(): fc.Arbitrary<string> {
  return numberLexemeArbitrary()
    .map((lexeme) => Number(lexeme))
    .filter(
      (value) =>
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value)),
    )
    .map((value) => String(value));
}

/**
 * A scalar `JsonNode` TOML can represent: boolean, string, or (double-safe)
 * number. Null is intentionally excluded — TOML has no null type. Ids are
 * placeholders (`structuralEquals`/`serialize` ignore them); keys are assigned
 * by the containing object/array.
 */
function tomlScalarArbitrary(): fc.Arbitrary<JsonNode> {
  return fc.oneof(
    fc
      .boolean()
      .map<JsonNode>((v) => ({ id: '', key: null, type: 'boolean', boolValue: v })),
    edgyStringArbitrary().map<JsonNode>((v) => ({
      id: '',
      key: null,
      type: 'string',
      stringValue: v,
    })),
    doubleSafeNumberLexemeArbitrary().map<JsonNode>((v) => ({
      id: '',
      key: null,
      type: 'number',
      numberValue: v,
    })),
  );
}

/** Build an array node from ordered child values, assigning index keys. */
function arrayNode(items: JsonNode[]): JsonNode {
  return {
    id: '',
    key: null,
    type: 'array',
    children: items.map((item, index) => ({ ...item, key: index })),
  };
}

/** Build an object node from `[key, value]` entries, assigning string keys. */
function objectNode(entries: Array<[string, JsonNode]>): JsonNode {
  return {
    id: '',
    key: null,
    type: 'object',
    children: entries.map(([key, value]) => ({ ...value, key })),
  };
}

/**
 * A null-free, double-safe JSON value (scalar, array, or non-empty object),
 * depth-bounded via a single `letrec`. Used for the values nested inside the
 * top-level table.
 */
function tomlValueArbitrary(): fc.Arbitrary<JsonNode> {
  const { node } = fc.letrec<{ node: JsonNode }>((tie) => ({
    node: fc.oneof(
      { maxDepth: 3, depthIdentifier: 'toml' },
      tomlScalarArbitrary(),
      fc.array(tie('node'), { maxLength: 5 }).map(arrayNode),
      fc
        .uniqueArray(fc.tuple(edgyStringArbitrary(), tie('node')), {
          selector: (entry) => entry[0],
          maxLength: 5,
        })
        .map(objectNode),
    ),
  }));
  return node;
}

/** The top-level model: a non-empty table, per TOML's documented domain. */
function tomlSafeJsonArbitrary(): fc.Arbitrary<JsonNode> {
  return fc
    .uniqueArray(fc.tuple(edgyStringArbitrary(), tomlValueArbitrary()), {
      selector: (entry) => entry[0],
      minLength: 1,
      maxLength: 5,
    })
    .map(objectNode);
}

describe('Property 24: TOML round-trip (Req 13.5, 13.6, 13.8)', () => {
  // Feature: json-viewer-free, Property 24: TOML round-trip
  // Validates: Requirements 13.5, 13.6, 13.8
  test.prop([tomlSafeJsonArbitrary()], { numRuns: 100 })(
    'JSON -> TOML -> JSON recovers a structurally identical model',
    (model) => {
      const jsonText = serialize(model);

      const toml = jsonToToml(jsonText);
      expect(toml.ok).toBe(true);
      if (!toml.ok) return;

      const back = tomlToJson(toml.text);
      expect(back.ok).toBe(true);
      if (!back.ok) return;

      const reparsed = parseJson(back.text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok || reparsed.empty) return;

      expect(structuralEquals(model, reparsed.model)).toBe(true);
    },
  );
});
