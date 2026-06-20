// Feature: json-viewer-free
//
// JSON <-> CSV converter (Req 13.3, 13.4, 13.6) built on `papaparse`.
//
//   - `jsonToCsv` is valid ONLY when the top-level value is an array of objects
//     that share an identical set of keys. It emits a single header row (each
//     unique key once, in first-appearance order) and one data row per element,
//     with values aligned to their column (Req 13.3). If the input is not an
//     array of objects, or the objects do not share an identical key set, it
//     returns a descriptive error identifying the reason and produces NO partial
//     output (Req 13.4).
//   - `csvToJson` parses CSV (header row -> object keys) into an array of
//     objects and returns JSON text (Req 13.6).

import Papa from 'papaparse';
import { parseJson } from '../json-core/parse';
import type { ConvertResult } from './types';

/**
 * Convert JSON `jsonText` to CSV (Req 13.3).
 *
 * Only an array of objects sharing an identical set of keys is convertible.
 * Any other shape is rejected with a descriptive reason and no partial output
 * (Req 13.4).
 */
export function jsonToCsv(jsonText: string): ConvertResult {
  const parsed = parseJson(jsonText);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        message: `Input is not valid JSON: ${parsed.error.message}`,
        line: parsed.error.line,
      },
    };
  }
  if (parsed.empty) {
    return { ok: false, error: { message: 'There is no JSON to convert to CSV.' } };
  }

  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, error: { message: messageOf(error, 'Could not read the JSON input.') } };
  }

  const validation = validateArrayOfUniformObjects(value);
  if (!validation.ok) {
    // Reject with a descriptive reason; emit no partial output (Req 13.4).
    return { ok: false, error: validation.error };
  }

  const { rows, fields } = validation;
  const data = rows.map((row) => fields.map((field) => toCell(row[field])));

  try {
    const text = Papa.unparse({ fields, data });
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: { message: messageOf(error, 'Could not build CSV from the JSON input.') } };
  }
}

/**
 * Convert CSV `csvText` to JSON text (Req 13.6).
 *
 * The first row is treated as the header; each subsequent row becomes an object
 * keyed by the header columns. Numeric and boolean cells are coerced to their
 * JSON types.
 */
export function csvToJson(csvText: string): ConvertResult {
  if (csvText.trim().length === 0) {
    return { ok: false, error: { message: 'There is no CSV to convert to JSON.' } };
  }

  const result = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  // A single-column CSV has no delimiter character, so papaparse emits a
  // NON-FATAL "UndetectableDelimiter" warning while still parsing the data
  // correctly. That shape (e.g. "c0:\nfalse" -> [{ "c0:": false }]) is within
  // the converter's convertible domain, so it must not be treated as a failure.
  // Only genuinely fatal parse errors should fail the conversion (Req 13.6).
  const fatalErrors = result.errors.filter(
    (error) => !(error.type === 'Delimiter' && error.code === 'UndetectableDelimiter'),
  );

  if (fatalErrors.length > 0) {
    const first = fatalErrors[0];
    return {
      ok: false,
      error: {
        message: `Input is not valid CSV: ${first.message}`,
        // Papa rows are 0-based; report a 1-based line where available.
        line: typeof first.row === 'number' ? first.row + 1 : undefined,
      },
    };
  }

  try {
    return { ok: true, text: JSON.stringify(result.data, null, 2) };
  } catch (error) {
    return { ok: false, error: { message: messageOf(error, 'Could not serialize the converted JSON.') } };
  }
}

/** A validated array of uniform objects, ready for row/field projection. */
interface UniformObjects {
  ok: true;
  rows: Array<Record<string, unknown>>;
  fields: string[];
}

/**
 * Validate that `value` is a non-empty array of plain objects all sharing an
 * identical set of keys. Returns the rows and the ordered field list on
 * success, or a descriptive error explaining exactly why the value is not
 * convertible to CSV (Req 13.4).
 */
function validateArrayOfUniformObjects(
  value: unknown,
): UniformObjects | { ok: false; error: { message: string; path?: string } } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: {
        message:
          'CSV conversion requires the top-level value to be an array of objects, ' +
          `but the input is a ${describeType(value)}.`,
        path: '$',
      },
    };
  }

  if (value.length === 0) {
    return {
      ok: false,
      error: {
        message:
          'CSV conversion requires a non-empty array of objects, but the array is empty ' +
          'so there are no columns to derive.',
        path: '$',
      },
    };
  }

  // Every element must be a plain object (not null, not an array, not a scalar).
  for (let i = 0; i < value.length; i++) {
    if (!isPlainObject(value[i])) {
      return {
        ok: false,
        error: {
          message:
            `CSV conversion requires every array element to be an object, but element ${i} ` +
            `is a ${describeType(value[i])}.`,
          path: `$[${i}]`,
        },
      };
    }
  }

  const rows = value as Array<Record<string, unknown>>;
  const fields = Object.keys(rows[0]);
  const expected = new Set(fields);

  // Every object must share an identical key set: same size and same members.
  for (let i = 1; i < rows.length; i++) {
    const keys = Object.keys(rows[i]);
    if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) {
      const missing = fields.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !expected.has(key));
      return {
        ok: false,
        error: {
          message:
            `CSV conversion requires every object to share an identical set of keys, but element ${i} ` +
            `differs from the first element.` +
            (missing.length > 0 ? ` Missing key(s): ${missing.join(', ')}.` : '') +
            (extra.length > 0 ? ` Unexpected key(s): ${extra.join(', ')}.` : ''),
          path: `$[${i}]`,
        },
      };
    }
  }

  return { ok: true, rows, fields };
}

/**
 * Render a single cell value for CSV output. Scalars pass through (papaparse
 * handles quoting/escaping); `null`/`undefined` become an empty cell; nested
 * objects and arrays are serialized as JSON so the column stays aligned.
 */
function toCell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value as string | number | boolean;
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short human-readable description of a value's JSON-ish type. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Extract a message from an unknown error, falling back to `fallback`. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
