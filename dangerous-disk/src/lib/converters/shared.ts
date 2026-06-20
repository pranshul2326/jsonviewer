// Feature: json-viewer-free
//
// Shared plumbing for the format converters (YAML, TOML, and — later — XML,
// CSV). Two concerns live here:
//
//   1. A uniform result type (`ConverterResult`) so every converter returns a
//      typed `{ ok: true, text } | { ok: false, error }` value rather than
//      throwing raw errors (design.md "converter interface"). The error carries
//      an optional 1-based `line` and/or a JSON-path `path` locating the
//      offending content where determinable (Req 13.10).
//
//   2. A bridge between the `json-core` `JsonNode` model and the plain
//      JavaScript value trees that `js-yaml`/`smol-toml` consume and produce.
//
// The forward direction (JSON → YAML/TOML) always goes through `parseJson`
// (json-core), so object key order and numeric precision are taken from the
// model rather than from a lossy `JSON.parse` (design.md). The reverse direction
// (YAML/TOML → JSON) emits text with `lossless-json`'s `stringify`, which can
// faithfully serialize `bigint` integers produced by `smol-toml`.

import { stringify as stringifyLossless } from 'lossless-json';
import { parseJson, type ParseResult } from '../json-core/parse';
import type { JsonNode } from '../json-core/types';

/** A located converter error (Req 13.10). */
export interface ConverterError {
  /** Human-readable description of why the conversion failed. */
  message: string;
  /** 1-based line of the offending content, when determinable. */
  line?: number;
  /** JSON-path of the offending content, when determinable. */
  path?: string;
}

/**
 * The outcome of a conversion: either the produced `text`, or a typed `error`.
 * Converters never throw for ordinary, user-correctable problems; they return
 * `{ ok: false, error }` instead.
 */
export type ConverterResult =
  | { ok: true; text: string }
  | { ok: false; error: ConverterError };

/** Convenience constructor for a successful conversion. */
export function ok(text: string): ConverterResult {
  return { ok: true, text };
}

/** Convenience constructor for a failed conversion. */
export function fail(message: string, extra?: { line?: number; path?: string }): ConverterResult {
  return { ok: false, error: { message, ...extra } };
}

/**
 * Parse JSON source text into a `JsonNode` model for the forward direction.
 * Returns the model on success, or a `ConverterResult` error to forward
 * directly to the caller (covering empty input and JSON syntax errors).
 */
export function parseSourceJson(
  jsonText: string,
): { model: JsonNode } | ConverterResult {
  const result: ParseResult = parseJson(jsonText);
  if (result.ok && result.empty) {
    return fail('Input is empty; there is no JSON to convert.');
  }
  if (!result.ok) {
    return fail(result.error.message, {
      line: result.error.line,
    });
  }
  return { model: result.model };
}

/**
 * Convert a `JsonNode` model into a plain JavaScript value suitable for
 * `js-yaml`/`smol-toml` to serialize. Object key order and array order are
 * preserved (object members are emitted in the model's `children` order).
 *
 * Numbers are reconstructed from their raw lexeme:
 *   - when `useBigInt` is set, integer lexemes outside the safe-integer range
 *     become `bigint` so precision survives (TOML's serializer accepts these);
 *   - otherwise (YAML, whose engine cannot serialize `bigint`) every number is
 *     a JS `number`.
 */
/**
 * Assign `value` to `key` as an *own, enumerable data property* of `target`.
 *
 * Plain assignment (`target[key] = value`) is unsafe for keys that collide with
 * accessors on `Object.prototype` — most notably `__proto__`, whose inherited
 * setter would reinterpret the assignment as a prototype change rather than
 * storing a data property, silently dropping the key (and risking prototype
 * pollution). Using `Object.defineProperty` bypasses inherited accessors so any
 * key — including `__proto__`, `constructor`, and `prototype` — is preserved as
 * an ordinary data member that round-trips faithfully.
 */
function assignDataKey(
  target: { [key: string]: unknown },
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function modelToPlain(node: JsonNode, useBigInt: boolean): unknown {
  switch (node.type) {
    case 'null':
      return null;
    case 'boolean':
      return node.boolValue ?? false;
    case 'string':
      return node.stringValue ?? '';
    case 'number':
      return lexemeToNumber(node.numberValue ?? '0', useBigInt);
    case 'array':
      return (node.children ?? []).map((child) => modelToPlain(child, useBigInt));
    case 'object': {
      const result: { [key: string]: unknown } = {};
      for (const child of node.children ?? []) {
        assignDataKey(result, String(child.key), modelToPlain(child, useBigInt));
      }
      return result;
    }
    default: {
      const _exhaustive: never = node.type;
      throw new Error(`Unsupported JsonType: ${String(_exhaustive)}`);
    }
  }
}

/** Convert a numeric lexeme to a `number`, or a `bigint` when requested and needed. */
function lexemeToNumber(lexeme: string, useBigInt: boolean): number | bigint {
  if (useBigInt && /^-?\d+$/.test(lexeme)) {
    const asNumber = Number(lexeme);
    if (!Number.isSafeInteger(asNumber)) {
      try {
        return BigInt(lexeme);
      } catch {
        return asNumber;
      }
    }
    return asNumber;
  }
  return Number(lexeme);
}

/**
 * Find the JSON-path of the first `null` encountered in a model, in document
 * order, or `null` if the model contains no nulls. Used by the TOML converter,
 * since TOML has no null representation.
 */
export function findFirstNullPath(node: JsonNode, path = '$'): string | null {
  switch (node.type) {
    case 'null':
      return path;
    case 'array': {
      const children = node.children ?? [];
      for (let i = 0; i < children.length; i++) {
        const found = findFirstNullPath(children[i], `${path}[${i}]`);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    case 'object': {
      for (const child of node.children ?? []) {
        const found = findFirstNullPath(child, `${path}.${String(child.key)}`);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Recursively sanitize a plain value produced by a format parser so it can be
 * emitted as JSON text:
 *   - `Date` (including `smol-toml`'s `TomlDate`) becomes its ISO 8601 string,
 *   - `undefined` becomes `null` (defensive; parsers rarely produce it),
 *   - `bigint`, `number`, `string`, `boolean`, and `null` pass through,
 *   - arrays and plain objects are sanitized element/member-wise.
 */
export function sanitizeForJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((element) => sanitizeForJson(element));
  }
  if (typeof value === 'object') {
    const result: { [key: string]: unknown } = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      assignDataKey(result, key, sanitizeForJson(member));
    }
    return result;
  }
  // bigint, number, string, boolean
  return value;
}

/**
 * Serialize a sanitized plain value into pretty-printed (2-space) JSON text
 * using `lossless-json`, which renders `bigint` integers without loss.
 */
export function plainToJsonText(value: unknown): string {
  return stringifyLossless(value, undefined, 2) ?? 'null';
}
