// Feature: json-viewer-free
//
// Shared property-based testing harness: `fast-check` arbitraries plus the
// structural-equality oracle. Every property test in the suite draws its
// inputs from the generators defined here, so they are intentionally biased
// toward the edge cases the design's correctness properties care about:
//
//   - nested objects/arrays,
//   - edge-y strings (unicode, quotes, escapes, whitespace, empty),
//   - numbers spanning integers, floats, big integers, and high-precision
//     decimal lexemes (to exercise lossless precision),
//   - rich-media value spaces (image URLs, hex colors, Unix timestamps),
//   - deformed JSON text (trailing commas, unquoted keys, single-quote
//     delimiters) carrying the exact per-category deformation counts, and
//   - node edit operations (add key / delete / rename / edit scalar).
//
// The single equality oracle, `structuralEquals`, is re-exported from
// `canonical.ts` so tests import it from one place (see design "Equality
// helper").

import fc from 'fast-check';
import type { JsonNode } from '../lib/json-core/types';
import { structuralEquals } from '../lib/json-core/canonical';

// Re-export the structural-equality oracle so tests have a single import site.
export { structuralEquals };

/** Id of the document root node (mirrors `model.ts`). */
const ROOT_ID = '$';

/**
 * Build a stable child id from a parent id and a key, encoded so ids remain
 * unique regardless of key contents (mirrors `model.ts`'s `childId`).
 */
function childId(parentId: string, key: string | number): string {
  return `${parentId}/${encodeURIComponent(String(key))}`;
}

// ---------------------------------------------------------------------------
// Internal value specification + materialization
// ---------------------------------------------------------------------------
//
// We generate a lightweight `Spec` tree first (no ids/keys), then materialize
// it into a fully-formed `JsonNode` tree with model-consistent ids and keys.
// This keeps the recursive generator simple while still producing nodes that
// match the shape the rest of the system expects.

type Spec =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'string'; v: string }
  | { t: 'number'; v: string }
  | { t: 'array'; items: Spec[] }
  | { t: 'object'; entries: Array<[string, Spec]> };

/** Materialize a `Spec` into a `JsonNode`, assigning model-consistent ids. */
function materialize(
  spec: Spec,
  key: string | number | null,
  id: string,
): JsonNode {
  switch (spec.t) {
    case 'null':
      return { id, key, type: 'null' };
    case 'bool':
      return { id, key, type: 'boolean', boolValue: spec.v };
    case 'string':
      return { id, key, type: 'string', stringValue: spec.v };
    case 'number':
      return { id, key, type: 'number', numberValue: spec.v };
    case 'array':
      return {
        id,
        key,
        type: 'array',
        children: spec.items.map((item, index) =>
          materialize(item, index, childId(id, index)),
        ),
      };
    case 'object':
      return {
        id,
        key,
        type: 'object',
        children: spec.entries.map(([childKey, childSpec]) =>
          materialize(childSpec, childKey, childId(id, childKey)),
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Scalar building blocks
// ---------------------------------------------------------------------------

/**
 * Strings biased toward the cases that break naive JSON handling: unicode,
 * embedded quotes, backslashes, whitespace, control characters, the empty
 * string, and literal-looking words.
 */
export function edgyStringArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.string(),
    fc.fullUnicodeString(),
    fc.constantFrom(
      '',
      ' ',
      '\t',
      '\n',
      'a\nb',
      '"',
      '\\',
      "'",
      'a"b',
      "a'b",
      'a\\b',
      '{}',
      '[]',
      'true',
      'false',
      'null',
      '0',
      '  spaced  ',
      '😀',
      'café',
      'Ω≈ç√',
      '\u0000',
      '\u001f',
    ),
  );
}

/** A single decimal digit as a string. */
const digitArbitrary = fc.integer({ min: 0, max: 9 }).map(String);

/** A run of `[min, max]` decimal digits as a string (possibly empty). */
function digitRun(min: number, max: number): fc.Arbitrary<string> {
  return fc
    .array(digitArbitrary, { minLength: min, maxLength: max })
    .map((digits) => digits.join(''));
}

/** Ordinary signed integer lexeme, e.g. `"0"`, `"-42"`. */
function integerLexemeArbitrary(): fc.Arbitrary<string> {
  return fc.integer().map(String);
}

/** Big-integer lexeme well beyond IEEE-754 safe range, e.g. `"-90071992547409930"`. */
function bigIntLexemeArbitrary(): fc.Arbitrary<string> {
  return fc.bigInt().map((value) => value.toString());
}

/** Finite floating-point lexeme, e.g. `"0.5"`, `"-1.25e-7"`. */
function floatLexemeArbitrary(): fc.Arbitrary<string> {
  return fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .map((value) => String(value))
    .filter((lexeme) =>
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(lexeme),
    );
}

/** Large integer lexeme of 15–40 digits with no leading zero. */
function largeIntLexemeArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('', '-'),
      fc.integer({ min: 1, max: 9 }).map(String),
      digitRun(14, 39),
    )
    .map(([sign, lead, rest]) => `${sign}${lead}${rest}`);
}

/** High-precision decimal lexeme with a long fractional part. */
function highPrecisionLexemeArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('', '-'),
      fc.integer({ min: 1, max: 9 }).map(String),
      digitRun(0, 24),
      digitRun(1, 30),
    )
    .map(([sign, lead, intRest, frac]) => `${sign}${lead}${intRest}.${frac}`);
}

/** A valid JSON number lexeme spanning the full numeric edge-case space. */
export function numberLexemeArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    integerLexemeArbitrary(),
    bigIntLexemeArbitrary(),
    floatLexemeArbitrary(),
    largeIntLexemeArbitrary(),
    highPrecisionLexemeArbitrary(),
  );
}

/** A scalar `Spec` (null, boolean, string, or number). */
function scalarSpecArbitrary(): fc.Arbitrary<Spec> {
  return fc.oneof(
    fc.constant<Spec>({ t: 'null' }),
    fc.boolean().map((v): Spec => ({ t: 'bool', v })),
    edgyStringArbitrary().map((v): Spec => ({ t: 'string', v })),
    numberLexemeArbitrary().map((v): Spec => ({ t: 'number', v })),
  );
}

// ---------------------------------------------------------------------------
// Core JSON arbitrary
// ---------------------------------------------------------------------------

/** Recursive `Spec` generator with bounded depth and breadth. */
function specArbitrary(): fc.Arbitrary<Spec> {
  const { node } = fc.letrec<{ node: Spec }>((tie) => ({
    node: fc.oneof(
      { maxDepth: 3, depthIdentifier: 'json' },
      scalarSpecArbitrary(),
      fc
        .array(tie('node'), { maxLength: 5 })
        .map((items): Spec => ({ t: 'array', items })),
      fc
        .uniqueArray(fc.tuple(edgyStringArbitrary(), tie('node')), {
          selector: (entry) => entry[0],
          maxLength: 5,
        })
        .map((entries): Spec => ({ t: 'object', entries })),
    ),
  }));
  return node;
}

/**
 * Arbitrary JSON document as a `JsonNode` tree: nested objects/arrays with
 * edge-y string and number leaves. This is the workhorse generator behind the
 * round-trip and equivalence properties.
 */
export function jsonArbitrary(): fc.Arbitrary<JsonNode> {
  return specArbitrary().map((spec) => materialize(spec, null, ROOT_ID));
}

/** A scalar `JsonNode` (null/boolean/string/number) at the document root. */
export function scalarJsonArbitrary(): fc.Arbitrary<JsonNode> {
  return scalarSpecArbitrary().map((spec) => materialize(spec, null, ROOT_ID));
}

// ---------------------------------------------------------------------------
// Grid arbitrary
// ---------------------------------------------------------------------------

/**
 * An array of uniform objects: every element is an object sharing the exact
 * same set of keys, with scalar values. Exercises the Table Grid transforms,
 * where the distinct keys become columns and elements become rows.
 */
export function arrayOfUniformObjectsArbitrary(): fc.Arbitrary<JsonNode> {
  const columnsArbitrary = fc.uniqueArray(edgyStringArbitrary(), {
    minLength: 1,
    maxLength: 5,
  });

  return columnsArbitrary.chain((columns) =>
    fc
      .array(fc.tuple(...columns.map(() => scalarSpecArbitrary())), {
        minLength: 1,
        maxLength: 8,
      })
      .map((rows) => {
        const arraySpec: Spec = {
          t: 'array',
          items: rows.map((values) => ({
            t: 'object',
            entries: columns.map(
              (column, index): [string, Spec] => [column, values[index]],
            ),
          })),
        };
        return materialize(arraySpec, null, ROOT_ID);
      }),
  );
}

// ---------------------------------------------------------------------------
// Rich-media arbitraries
// ---------------------------------------------------------------------------

/** A run of `[1, 10]` URL-safe alphanumeric characters (never empty). */
const urlSegmentArbitrary = fc
  .string({ minLength: 1, maxLength: 10 })
  .map((raw) => {
    const cleaned = raw.replace(/[^A-Za-z0-9]/g, '');
    return cleaned.length > 0 ? cleaned : 'seg';
  });

/**
 * An http(s) URL ending in a recognized image extension (`.png`, `.jpg`,
 * `.jpeg`, `.gif`, `.webp`, `.svg`), with mixed-case schemes/extensions to
 * exercise the case-insensitive match (Req 12.1).
 */
export function imageUrlArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('http://', 'https://', 'HTTP://', 'HTTPS://'),
      urlSegmentArbitrary,
      fc.array(urlSegmentArbitrary, { maxLength: 3 }),
      fc.constantFrom(
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.svg',
        '.PNG',
        '.JpG',
      ),
    )
    .map(([scheme, host, segments, extension]) => {
      const path = segments.length > 0 ? `/${segments.join('/')}` : '';
      return `${scheme}${host}.com${path}/photo${extension}`;
    });
}

/**
 * A `#` hex color of exactly 3, 6, or 8 hexadecimal digits (case-insensitive),
 * matching the hex-color classification space (Req 12.3).
 */
export function hexColorArbitrary(): fc.Arbitrary<string> {
  const hexDigit = fc.constantFrom(...'0123456789abcdefABCDEF'.split(''));
  const hexRun = (length: number): fc.Arbitrary<string> =>
    fc
      .array(hexDigit, { minLength: length, maxLength: length })
      .map((digits) => digits.join(''));

  return fc
    .oneof(hexRun(3), hexRun(6), hexRun(8))
    .map((digits) => `#${digits}`);
}

/**
 * A number within the inclusive Unix timestamp range `[0, 4102444800]`
 * (seconds since the epoch), the timestamp classification space (Req 12.4).
 */
export function timestampArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: 0, max: 4102444800 }),
    fc.double({ min: 0, max: 4102444800, noNaN: true, noDefaultInfinity: true }),
  );
}

// ---------------------------------------------------------------------------
// Smart Fixer (deformed JSON) arbitrary
// ---------------------------------------------------------------------------

/**
 * A valid JSON document together with a deformed textual rendering of it and
 * the exact number of deformations introduced per category. The deformations
 * are confined to the three mechanically-correctable categories the Smart
 * Fixer repairs, so the corrected output is guaranteed to round-trip back to
 * `model` (Req 7) while the counts feed the correction-summary property.
 */
export interface DeformedJson {
  /** The original, valid JSON document. */
  model: JsonNode;
  /** A textual rendering of `model` with deformations introduced. */
  deformed: string;
  /** The number of deformations introduced, per correctable category. */
  counts: {
    /** Trailing commas added before a `}` or `]`. */
    trailingCommas: number;
    /** Object keys emitted unquoted. */
    unquotedKeys: number;
    /** String values emitted with single-quote delimiters. */
    singleQuotes: number;
  };
}

/** Reserved barewords that must never be emitted as an unquoted object key. */
const JSON_LITERAL_WORDS = new Set(['true', 'false', 'null']);

/** True when `key` is a bareword that may safely be emitted unquoted. */
function isUnquotableKey(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !JSON_LITERAL_WORDS.has(key);
}

/** Escape a string as a double-quoted JSON string literal (with quotes). */
function escapeDoubleQuoted(value: string): string {
  let result = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x22:
        result += '\\"';
        break;
      case 0x5c:
        result += '\\\\';
        break;
      case 0x08:
        result += '\\b';
        break;
      case 0x09:
        result += '\\t';
        break;
      case 0x0a:
        result += '\\n';
        break;
      case 0x0c:
        result += '\\f';
        break;
      case 0x0d:
        result += '\\r';
        break;
      default:
        result += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : value[i];
    }
  }
  return result + '"';
}

/**
 * Emit a string as a single-quoted literal whose contents the Smart Fixer's
 * single-quote conversion reverses exactly: single quotes are escaped as `\'`,
 * backslashes doubled, control characters JSON-escaped, and interior double
 * quotes left bare (the fixer re-escapes them when re-delimiting).
 */
function escapeSingleQuoted(value: string): string {
  let result = "'";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x27: // '
        result += "\\'";
        break;
      case 0x5c: // \
        result += '\\\\';
        break;
      case 0x08:
        result += '\\b';
        break;
      case 0x09:
        result += '\\t';
        break;
      case 0x0a:
        result += '\\n';
        break;
      case 0x0c:
        result += '\\f';
        break;
      case 0x0d:
        result += '\\r';
        break;
      case 0x22: // " — left bare; the fixer escapes it when re-delimiting
        result += '"';
        break;
      default:
        result += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : value[i];
    }
  }
  return result + "'";
}

/** Decision-point counts used to size the per-category decision streams. */
interface DecisionPoints {
  keys: number;
  strings: number;
  containers: number;
}

/** Count the deformation decision points in a model (matches `emitDeformed`). */
function countDecisionPoints(node: JsonNode): DecisionPoints {
  const points: DecisionPoints = { keys: 0, strings: 0, containers: 0 };

  const walk = (current: JsonNode): void => {
    switch (current.type) {
      case 'string':
        points.strings += 1;
        return;
      case 'array': {
        const children = current.children ?? [];
        if (children.length > 0) {
          points.containers += 1;
        }
        children.forEach(walk);
        return;
      }
      case 'object': {
        const children = current.children ?? [];
        if (children.length > 0) {
          points.containers += 1;
        }
        for (const child of children) {
          if (isUnquotableKey(String(child.key ?? ''))) {
            points.keys += 1;
          }
          walk(child);
        }
        return;
      }
      default:
        return;
    }
  };

  walk(node);
  return points;
}

/** Mutable cursors into the three decision streams. */
interface Cursors {
  key: number;
  str: number;
  cont: number;
}

/**
 * Emit a deformed textual rendering of `node`, consuming one boolean per
 * decision point from the supplied streams and tallying the deformations made.
 */
function emitDeformed(
  node: JsonNode,
  keyDecisions: boolean[],
  stringDecisions: boolean[],
  containerDecisions: boolean[],
  cursors: Cursors,
  counts: DeformedJson['counts'],
): string {
  switch (node.type) {
    case 'null':
      return 'null';
    case 'boolean':
      return node.boolValue ? 'true' : 'false';
    case 'number':
      return node.numberValue ?? '0';
    case 'string': {
      const value = node.stringValue ?? '';
      const useSingleQuotes = stringDecisions[cursors.str++];
      if (useSingleQuotes) {
        counts.singleQuotes += 1;
        return escapeSingleQuoted(value);
      }
      return escapeDoubleQuoted(value);
    }
    case 'array': {
      const children = node.children ?? [];
      const elements = children.map((child) =>
        emitDeformed(
          child,
          keyDecisions,
          stringDecisions,
          containerDecisions,
          cursors,
          counts,
        ),
      );
      let body = elements.join(',');
      if (children.length > 0 && containerDecisions[cursors.cont++]) {
        counts.trailingCommas += 1;
        body += ',';
      }
      return `[${body}]`;
    }
    case 'object': {
      const children = node.children ?? [];
      const members = children.map((child) => {
        const keyText = String(child.key ?? '');
        let renderedKey: string;
        if (isUnquotableKey(keyText)) {
          if (keyDecisions[cursors.key++]) {
            counts.unquotedKeys += 1;
            renderedKey = keyText;
          } else {
            renderedKey = escapeDoubleQuoted(keyText);
          }
        } else {
          renderedKey = escapeDoubleQuoted(keyText);
        }
        const renderedValue = emitDeformed(
          child,
          keyDecisions,
          stringDecisions,
          containerDecisions,
          cursors,
          counts,
        );
        return `${renderedKey}:${renderedValue}`;
      });
      let body = members.join(',');
      if (children.length > 0 && containerDecisions[cursors.cont++]) {
        counts.trailingCommas += 1;
        body += ',';
      }
      return `{${body}}`;
    }
    default:
      return 'null';
  }
}

/** A boolean array of exactly `length` elements. */
function fixedBooleanArray(length: number): fc.Arbitrary<boolean[]> {
  return length <= 0
    ? fc.constant<boolean[]>([])
    : fc.array(fc.boolean(), { minLength: length, maxLength: length });
}

/**
 * A valid JSON document paired with a deformed rendering (trailing commas,
 * unquoted keys, and/or single-quote string delimiters) and the exact
 * per-category deformation counts.
 */
export function deformedJsonArbitrary(): fc.Arbitrary<DeformedJson> {
  return jsonArbitrary().chain((model) => {
    const points = countDecisionPoints(model);
    return fc
      .tuple(
        fixedBooleanArray(points.keys),
        fixedBooleanArray(points.strings),
        fixedBooleanArray(points.containers),
      )
      .map(([keyDecisions, stringDecisions, containerDecisions]) => {
        const counts: DeformedJson['counts'] = {
          trailingCommas: 0,
          unquotedKeys: 0,
          singleQuotes: 0,
        };
        const cursors: Cursors = { key: 0, str: 0, cont: 0 };
        const deformed = emitDeformed(
          model,
          keyDecisions,
          stringDecisions,
          containerDecisions,
          cursors,
          counts,
        );
        return { model, deformed, counts };
      });
  });
}

// ---------------------------------------------------------------------------
// Node edit arbitrary
// ---------------------------------------------------------------------------

/**
 * A single node edit operation the editor supports (Property 10/11):
 *   - `addKey`     — add a new object member with the given key and value,
 *   - `delete`     — delete the target node,
 *   - `rename`     — rename an object key to `newKey`,
 *   - `editScalar` — replace a scalar node's value with `value` (a scalar).
 *
 * The operation carries its payload only; the target node/path is chosen by
 * the consuming property test from the document under test.
 */
export type EditOperation =
  | { kind: 'addKey'; key: string; value: JsonNode }
  | { kind: 'delete' }
  | { kind: 'rename'; newKey: string }
  | { kind: 'editScalar'; value: JsonNode };

/** An arbitrary node edit operation spanning all four supported kinds. */
export function editOperationArbitrary(): fc.Arbitrary<EditOperation> {
  return fc.oneof(
    fc
      .tuple(edgyStringArbitrary(), jsonArbitrary())
      .map(([key, value]): EditOperation => ({ kind: 'addKey', key, value })),
    fc.constant<EditOperation>({ kind: 'delete' }),
    edgyStringArbitrary().map(
      (newKey): EditOperation => ({ kind: 'rename', newKey }),
    ),
    scalarJsonArbitrary().map(
      (value): EditOperation => ({ kind: 'editScalar', value }),
    ),
  );
}
