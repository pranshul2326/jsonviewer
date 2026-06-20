// Feature: json-viewer-free
//
// Property test for the JSON ↔ XML converter in `xml.ts` (Req 13.2, 13.6).
//
//   - Property 25 (XML half): XML structure-preservation round-trip
//     (Req 13.2, 13.6)
//
// The round-trip pipeline mirrors the way the application drives the converter:
//
//   JsonNode --serialize--> JSON text --jsonToXml--> XML text
//            --xmlToJson--> JSON text --parseJson--> JsonNode'
//
// and asserts the original and recovered models are structurally and value-wise
// identical under `structuralEquals` (which ignores insignificant object key
// ordering and compares numbers by value).
//
// Domain note (converter contract, see xml.ts header): the XML bridge wraps the
// document under a single `<root>` element, ignores attributes, escapes text
// via the library's entity handling, type-coerces scalar text on the way back
// (`parseTagValue`), and trims leading/trailing whitespace from text nodes
// (`trimValues`). XML therefore faithfully round-trips only a constrained
// domain. We honour that documented domain by drawing from a generator confined
// to it — rather than weakening the equivalence assertion — exactly as
// `yaml.test.ts` / `toml.test.ts` do:
//
//   - The root is a non-empty object whose keys are valid XML element names
//     (XML cannot encode arbitrary keys or an empty document).
//   - Nested objects are non-empty (an empty element parses back as empty text,
//     not an empty object).
//   - Arrays appear only as object values and have length >= 2, because a single
//     repeated element is indistinguishable from a lone scalar on parse, and
//     array-of-array nesting has no element-repetition encoding. Array items are
//     scalars or (non-empty) objects.
//   - Scalars are booleans, double-safe numbers, or "XML-safe" strings that
//     begin and end with an ASCII letter (so `trimValues` never alters them and
//     they are never coerced to a number/boolean) while still embedding the
//     escape-sensitive characters (`" ' & < >`, spaces, commas, unicode). Null
//     is excluded — it has no faithful XML text encoding here.

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from '../json-core/types';
import { parseJson } from '../json-core/parse';
import { serialize } from '../json-core/serialize';
import { structuralEquals } from '../../test/arbitraries';
import { jsonToXml, xmlToJson } from './xml';

// ---------------------------------------------------------------------------
// XML-safe scalar building blocks
// ---------------------------------------------------------------------------

/** A single ASCII letter, used to anchor both ends of an XML-safe string. */
const asciiLetter = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
);

/**
 * An XML-safe string: it begins and ends with an ASCII letter (so the parser's
 * `trimValues` never alters it and it is never coerced to a number or boolean)
 * while its interior still exercises the escape-sensitive characters the
 * builder must encode and the parser must decode (`"`, `'`, `&`, `<`, `>`,
 * spaces, commas, digits, and a sampling of unicode). Control characters are
 * excluded as they are not representable in XML 1.0 text.
 */
function xmlSafeStringArbitrary(): fc.Arbitrary<string> {
  const interior = fc.oneof(
    // `fc.string()` yields printable ASCII (0x20–0x7e): quotes, &, <, >, comma…
    fc.string(),
    fc.constantFrom(
      'a"b',
      "a'b",
      'a&b',
      'a<b>c',
      'x,y',
      'has space',
      '100',
      'true',
      'false',
      'café',
      'Ω≈ç',
      '😀',
    ),
  );
  return fc
    .tuple(asciiLetter, interior, asciiLetter)
    .map(([head, mid, tail]) => `${head}${mid}${tail}`);
}

/**
 * A number lexeme in XML's round-trippable numeric domain: a finite double that
 * is either a safe integer or a non-integer. Integers outside the safe range
 * are excluded (JSON.parse, used by the converter, would already lose their
 * precision). Each value is emitted in canonical double form so the model
 * number is exactly the double `parseTagValue` recovers.
 */
function doubleSafeNumberLexemeArbitrary(): fc.Arbitrary<string> {
  return fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter(
      (value) =>
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value)),
    )
    .map((value) => String(value));
}

/**
 * An XML-safe scalar `JsonNode`: boolean, double-safe number, or XML-safe
 * string. Null is intentionally excluded (no faithful XML text encoding). Ids
 * are placeholders (`structuralEquals`/`serialize` ignore them); keys are
 * assigned by the containing object/array.
 */
function xmlScalarArbitrary(): fc.Arbitrary<JsonNode> {
  return fc.oneof(
    fc
      .boolean()
      .map<JsonNode>((v) => ({ id: '', key: null, type: 'boolean', boolValue: v })),
    doubleSafeNumberLexemeArbitrary().map<JsonNode>((v) => ({
      id: '',
      key: null,
      type: 'number',
      numberValue: v,
    })),
    xmlSafeStringArbitrary().map<JsonNode>((v) => ({
      id: '',
      key: null,
      type: 'string',
      stringValue: v,
    })),
  );
}

// ---------------------------------------------------------------------------
// XML-safe element names and structure
// ---------------------------------------------------------------------------

/** A valid XML element name: a letter/underscore followed by name characters. */
function xmlNameArbitrary(): fc.Arbitrary<string> {
  const nameChar = fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split(''),
  );
  return fc
    .tuple(asciiLetter, fc.array(nameChar, { maxLength: 6 }))
    .map(([head, rest]) => `${head}${rest.join('')}`);
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
 * An XML-representable value (scalar, length>=2 array of scalars/objects, or
 * non-empty object), depth-bounded via a single `letrec`. Arrays only appear
 * here as values and never directly nest other arrays.
 */
function xmlValueArbitrary(): fc.Arbitrary<JsonNode> {
  const { node } = fc.letrec<{ node: JsonNode; nonArray: JsonNode }>((tie) => ({
    // `nonArray` is what an array element may be: a scalar or a non-empty
    // object — never another array (XML has no array-of-array encoding).
    nonArray: fc.oneof(
      { maxDepth: 2, depthIdentifier: 'xml' },
      xmlScalarArbitrary(),
      fc
        .uniqueArray(fc.tuple(xmlNameArbitrary(), tie('node')), {
          selector: (entry) => entry[0],
          minLength: 1,
          maxLength: 4,
        })
        .map(objectNode),
    ),
    node: fc.oneof(
      { maxDepth: 2, depthIdentifier: 'xml' },
      xmlScalarArbitrary(),
      // Arrays must have length >= 2 to be recoverable as arrays on parse.
      fc.array(tie('nonArray'), { minLength: 2, maxLength: 5 }).map(arrayNode),
      fc
        .uniqueArray(fc.tuple(xmlNameArbitrary(), tie('node')), {
          selector: (entry) => entry[0],
          minLength: 1,
          maxLength: 4,
        })
        .map(objectNode),
    ),
  }));
  return node;
}

/** The top-level model: a non-empty object, per XML's documented domain. */
function xmlSafeJsonArbitrary(): fc.Arbitrary<JsonNode> {
  return fc
    .uniqueArray(fc.tuple(xmlNameArbitrary(), xmlValueArbitrary()), {
      selector: (entry) => entry[0],
      minLength: 1,
      maxLength: 5,
    })
    .map(objectNode);
}

describe('Property 25: XML structure-preservation round-trip (Req 13.2, 13.6)', () => {
  // Feature: json-viewer-free, Property 25: XML and CSV structure preservation round-trips
  // Validates: Requirements 13.2, 13.6
  test.prop([xmlSafeJsonArbitrary()], { numRuns: 100 })(
    'JSON -> XML -> JSON recovers a structurally identical model',
    (model) => {
      const jsonText = serialize(model);

      const xml = jsonToXml(jsonText);
      expect(xml.ok).toBe(true);
      if (!xml.ok) return;

      const back = xmlToJson(xml.text);
      expect(back.ok).toBe(true);
      if (!back.ok) return;

      const reparsed = parseJson(back.text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok || reparsed.empty) return;

      expect(structuralEquals(model, reparsed.model)).toBe(true);
    },
  );
});
