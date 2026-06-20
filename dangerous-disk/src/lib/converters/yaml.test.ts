// Feature: json-viewer-free
//
// Property test for the JSON ↔ YAML converter in `yaml.ts` (Req 13.1, 13.6, 13.7).
//
//   - Property 23: YAML round-trip  (Req 13.1, 13.6, 13.7)
//
// The round-trip pipeline mirrors the way the application drives the converter:
//
//   JsonNode --serialize--> JSON text --jsonToYaml--> YAML text
//            --yamlToJson--> JSON text --parseJson--> JsonNode'
//
// and asserts the original and recovered models are structurally and value-wise
// identical under `structuralEquals` (which ignores insignificant object key
// ordering and compares numbers by value).
//
// Domain note (converter contract, see yaml.ts header): the YAML bridge emits
// numbers as JS `number`s because `js-yaml` cannot serialize `bigint`. The
// round-trip is therefore faithful only for values YAML can represent — i.e.
// numbers that survive an IEEE-754 double. We honour that documented domain by
// constraining the shared `jsonArbitrary` so every number is exactly a finite
// double, rather than weakening the equivalence assertion.

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from '../json-core/types';
import { parseJson } from '../json-core/parse';
import { serialize } from '../json-core/serialize';
import { jsonArbitrary, structuralEquals } from '../../test/arbitraries';
import { jsonToYaml, yamlToJson } from './yaml';

/**
 * Rewrite every number lexeme to the canonical string form of its IEEE-754
 * double value (and replace non-finite results with `"0"`). The resulting model
 * contains only numbers YAML's JS-number bridge can represent without loss,
 * matching the converter's documented numeric domain.
 */
function toDoubleSafe(node: JsonNode): JsonNode {
  switch (node.type) {
    case 'number': {
      const value = Number(node.numberValue ?? '0');
      return {
        ...node,
        numberValue: Number.isFinite(value) ? String(value) : '0',
      };
    }
    case 'array':
    case 'object':
      return { ...node, children: (node.children ?? []).map(toDoubleSafe) };
    default:
      return node;
  }
}

/** Arbitrary JSON model constrained to YAML's documented numeric domain. */
function yamlSafeJsonArbitrary(): fc.Arbitrary<JsonNode> {
  return jsonArbitrary().map(toDoubleSafe);
}

describe('Property 23: YAML round-trip (Req 13.1, 13.6, 13.7)', () => {
  // Feature: json-viewer-free, Property 23: YAML round-trip
  // Validates: Requirements 13.1, 13.6, 13.7
  test.prop([yamlSafeJsonArbitrary()], { numRuns: 100 })(
    'JSON -> YAML -> JSON recovers a structurally identical model',
    (model) => {
      const jsonText = serialize(model);

      const yaml = jsonToYaml(jsonText);
      expect(yaml.ok).toBe(true);
      if (!yaml.ok) return;

      const back = yamlToJson(yaml.text);
      expect(back.ok).toBe(true);
      if (!back.ok) return;

      const reparsed = parseJson(back.text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok || reparsed.empty) return;

      expect(structuralEquals(model, reparsed.model)).toBe(true);
    },
  );
});
