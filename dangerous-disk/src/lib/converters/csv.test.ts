// Feature: json-viewer-free
//
// Tests for the JSON ↔ CSV converter in `csv.ts` (Req 13.3, 13.4, 13.6):
//
//   - Property 25 (CSV half): CSV structure-preservation round-trip for an
//     array of uniform objects — the output has a header row containing each
//     key exactly once, one data row per element, and parsing the CSV back to
//     JSON restores the rows (Req 13.3, 13.6).
//   - Unit tests for the not-convertible error path: a non-array-of-objects
//     top-level value, or array elements that do not share an identical key
//     set, yield a descriptive error and NO partial output (Req 13.4).
//
// The round-trip pipeline mirrors the application's use of the converter:
//
//   JsonNode --serialize--> JSON text --jsonToCsv--> CSV text
//            --csvToJson--> JSON text --parseJson--> JsonNode'
//
// Domain note (converter contract, see csv.ts header): `csvToJson` parses with
// papaparse `dynamicTyping`, which coerces numeric/boolean cells back to their
// JSON types, and an empty cell is ambiguous. CSV therefore faithfully
// round-trips a constrained scalar domain. We honour that documented domain by
// drawing from the shared `arrayOfUniformObjectsArbitrary` and mapping each
// generated value into the CSV-representable space — rather than weakening the
// equivalence assertion — exactly as `yaml.test.ts` / `toml.test.ts` do:
//
//   - keys are made unique and non-empty (index-prefixed) and stripped of
//     control characters, while still embedding escape-sensitive characters
//     (`" , <newline>`-free) so CSV header quoting is exercised;
//   - string values are prefixed with a letter so they are never coerced to a
//     number/boolean and are never empty, with control characters stripped;
//   - numbers are reduced to double-safe canonical form (the values papaparse's
//     dynamic typing recovers losslessly);
//   - booleans are kept as-is (they round-trip through dynamic typing);
//   - null is remapped to `false` — an empty cell has no faithful, unambiguous
//     CSV encoding here.

import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import Papa from 'papaparse';

import type { JsonNode } from '../json-core/types';
import { parseJson } from '../json-core/parse';
import { serialize } from '../json-core/serialize';
import {
  arrayOfUniformObjectsArbitrary,
  structuralEquals,
} from '../../test/arbitraries';
import { jsonToCsv, csvToJson } from './csv';

// ---------------------------------------------------------------------------
// Map a generated array-of-uniform-objects into CSV's representable domain.
// ---------------------------------------------------------------------------

/** Strip XML/CSV-hostile control characters (including CR/LF/TAB). */
function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f]/g, '');
}

/** Map a scalar `JsonNode` into a CSV-round-trippable scalar. */
function toCsvSafeScalar(node: JsonNode): JsonNode {
  switch (node.type) {
    case 'boolean':
      return node;
    case 'number': {
      const value = Number(node.numberValue ?? '0');
      const safe =
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))
          ? value
          : 0;
      return { ...node, numberValue: String(safe) };
    }
    case 'string':
      // Prefix so the cell is never empty and never coerced to number/boolean.
      return { ...node, stringValue: `x${stripControl(node.stringValue ?? '')}` };
    case 'null':
      // No faithful empty-cell encoding; collapse to a representable boolean.
      return { id: node.id, key: node.key, type: 'boolean', boolValue: false };
    default:
      return node;
  }
}

/**
 * Map a generated `array-of-uniform-objects` model into the CSV-representable
 * domain: each object's keys are made unique/non-empty by index prefix (control
 * characters stripped) and consistent across rows, and each value is mapped to
 * a CSV-round-trippable scalar.
 */
function toCsvSafe(model: JsonNode): JsonNode {
  const rows = model.children ?? [];
  const columns = (rows[0]?.children ?? []).map(
    (child, index) => `c${index}:${stripControl(String(child.key ?? ''))}`,
  );
  return {
    ...model,
    children: rows.map((row) => ({
      ...row,
      children: (row.children ?? []).map((cell, index) => ({
        ...toCsvSafeScalar(cell),
        key: columns[index],
      })),
    })),
  };
}

/** A CSV-round-trippable array-of-uniform-objects model. */
function csvSafeArbitrary(): fc.Arbitrary<JsonNode> {
  return arrayOfUniformObjectsArbitrary().map(toCsvSafe);
}

describe('Property 25: CSV structure-preservation round-trip (Req 13.3, 13.6)', () => {
  // Feature: json-viewer-free, Property 25: XML and CSV structure preservation round-trips
  // Validates: Requirements 13.3, 13.6
  test.prop([csvSafeArbitrary()], { numRuns: 100 })(
    'JSON -> CSV has one header per key and one row per element, and CSV -> JSON restores the rows',
    (model) => {
      const rows = model.children ?? [];
      const columns = (rows[0]?.children ?? []).map((child) => String(child.key));

      const jsonText = serialize(model);

      const csv = jsonToCsv(jsonText);
      expect(csv.ok).toBe(true);
      if (!csv.ok) return;

      // Header row holds each key exactly once; one data row per element.
      const records = Papa.parse<string[]>(csv.text, { skipEmptyLines: true })
        .data as string[][];
      const header = records[0];
      expect(header.length).toBe(columns.length);
      expect(new Set(header)).toEqual(new Set(columns));
      expect(records.length - 1).toBe(rows.length);

      // Parsing the CSV back to JSON restores the rows.
      const back = csvToJson(csv.text);
      expect(back.ok).toBe(true);
      if (!back.ok) return;

      const reparsed = parseJson(back.text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok || reparsed.empty) return;

      expect(structuralEquals(model, reparsed.model)).toBe(true);
    },
  );
});

describe('CSV not-convertible error path produces a descriptive error and no output (Req 13.4)', () => {
  /** Assert a converter result is a descriptive failure with no partial output. */
  function expectDescriptiveError(result: ReturnType<typeof jsonToCsv>): void {
    expect(result.ok).toBe(false);
    // No partial output is produced on failure.
    expect((result as { text?: string }).text).toBeUndefined();
    if (!result.ok) {
      expect(typeof result.error.message).toBe('string');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  }

  it('rejects a top-level object (not an array)', () => {
    const result = jsonToCsv('{"a":1,"b":2}');
    expectDescriptiveError(result);
    if (!result.ok) {
      expect(result.error.message).toMatch(/array of objects/i);
      expect(result.error.message).toMatch(/object/i);
    }
  });

  it('rejects a top-level scalar (string)', () => {
    const result = jsonToCsv('"just a string"');
    expectDescriptiveError(result);
    if (!result.ok) {
      expect(result.error.message).toMatch(/array of objects/i);
    }
  });

  it('rejects a top-level scalar (number)', () => {
    const result = jsonToCsv('42');
    expectDescriptiveError(result);
  });

  it('rejects an empty array (no columns to derive)', () => {
    const result = jsonToCsv('[]');
    expectDescriptiveError(result);
    if (!result.ok) {
      expect(result.error.message).toMatch(/empty/i);
    }
  });

  it('rejects an array whose elements are scalars (not objects)', () => {
    const result = jsonToCsv('[1, 2, 3]');
    expectDescriptiveError(result);
    if (!result.ok) {
      expect(result.error.message).toMatch(/object/i);
    }
  });

  it('rejects an array mixing an object and a non-object element', () => {
    const result = jsonToCsv('[{"a":1}, 7]');
    expectDescriptiveError(result);
    if (!result.ok) {
      // The error identifies the offending element index.
      expect(result.error.message).toMatch(/element 1/i);
    }
  });

  it('rejects objects with a missing key (non-identical key sets)', () => {
    const result = jsonToCsv('[{"a":1,"b":2}, {"a":3}]');
    expectDescriptiveError(result);
    if (!result.ok) {
      expect(result.error.message).toMatch(/identical set of keys/i);
      expect(result.error.message).toMatch(/missing key/i);
      expect(result.error.message).toMatch(/\bb\b/);
    }
  });

  it('rejects objects with an extra key (non-identical key sets)', () => {
    const result = jsonToCsv('[{"a":1}, {"a":3,"c":4}]');
    expectDescriptiveError(result);
    if (!result.ok) {
      expect(result.error.message).toMatch(/identical set of keys/i);
      expect(result.error.message).toMatch(/unexpected key/i);
      expect(result.error.message).toMatch(/\bc\b/);
    }
  });
});
