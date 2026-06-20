// Feature: json-viewer-free
//
// JSON ↔ TOML conversion built on `smol-toml` (Req 13.5, 13.6).
//
//   jsonToToml(jsonText) : JSON text -> TOML text
//   tomlToJson(tomlText) : TOML text -> JSON text
//
// Bridging strategy mirrors the YAML converter: the forward direction parses
// the source through `json-core`'s `parseJson` so key order, nesting, and value
// types are preserved (Req 13.5). Integer lexemes outside the safe-integer
// range are bridged as `bigint`, which `smol-toml`'s serializer renders without
// loss.
//
// TOML limitations are surfaced as typed errors rather than silent data loss
// (Req 13.10):
//   - TOML's top level is always a table, so a JSON root that is not an object
//     (an array, scalar, or null) cannot be represented.
//   - TOML has no null type, so any null value is unconvertible; we report the
//     JSON-path of the first null.
// `smol-toml` also rejects integers it cannot represent in 64 bits on the way
// back in; that parse error is returned with its line/column (Req 13.10).

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  fail,
  findFirstNullPath,
  modelToPlain,
  ok,
  parseSourceJson,
  plainToJsonText,
  sanitizeForJson,
  type ConverterResult,
} from './shared';

/**
 * Convert JSON source text to TOML text.
 *
 * Preserves all keys, values, nesting structure, and value data types of the
 * source model. Returns a typed error for empty input, invalid JSON, a
 * non-object root, or any null value (none of which TOML can represent).
 */
export function jsonToToml(jsonText: string): ConverterResult {
  const parsed = parseSourceJson(jsonText);
  if ('ok' in parsed) {
    return parsed; // forward the parse error / empty-input error
  }

  const { model } = parsed;

  // TOML's top level is a table: the JSON root must be an object.
  if (model.type !== 'object') {
    return fail(
      `TOML can only represent a top-level table, but the JSON root is ${describeType(model.type)}.`,
      { path: '$' },
    );
  }

  // TOML has no null type.
  const nullPath = findFirstNullPath(model);
  if (nullPath !== null) {
    return fail(
      `TOML has no null type, so the null value at ${nullPath} cannot be converted.`,
      { path: nullPath },
    );
  }

  // smol-toml's serializer accepts bigint for large integers.
  const value = modelToPlain(model, /* useBigInt */ true);

  try {
    const text = stringifyToml(value as Record<string, unknown>);
    return ok(text);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : 'Failed to convert JSON to TOML.',
    );
  }
}

/**
 * Convert TOML source text to JSON text.
 *
 * Preserves all keys, values, and nesting structure of the source. TOML
 * datetimes are rendered as ISO 8601 strings in the JSON output. Returns a
 * typed error (with a 1-based line/column where available) for empty or
 * malformed TOML.
 */
export function tomlToJson(tomlText: string): ConverterResult {
  if (tomlText.trim().length === 0) {
    return fail('Input is empty; there is no TOML to convert.');
  }

  let value: unknown;
  try {
    value = parseToml(tomlText);
  } catch (error) {
    return fail(toErrorMessage(error), locationFromTomlError(error));
  }

  return ok(plainToJsonText(sanitizeForJson(value)));
}

/** A readable noun phrase for a non-object root type. */
function describeType(type: string): string {
  switch (type) {
    case 'array':
      return 'an array';
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'null':
      return 'null';
    default:
      return `a ${type}`;
  }
}

/** Best-effort message extraction for a thrown value. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Failed to parse TOML.';
}

/**
 * Extract a 1-based line (and column where present) from a `smol-toml`
 * `TomlError`, which exposes `line`/`column` fields. Returns `undefined` when
 * no location is available.
 */
function locationFromTomlError(error: unknown): { line?: number } | undefined {
  if (error && typeof error === 'object' && 'line' in error) {
    const line = (error as { line?: unknown }).line;
    if (typeof line === 'number') {
      return { line };
    }
  }
  return undefined;
}
