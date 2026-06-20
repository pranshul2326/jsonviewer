// Feature: json-viewer-free
//
// JSON ↔ YAML conversion built on `js-yaml` (Req 13.1, 13.6).
//
//   jsonToYaml(jsonText) : JSON text -> YAML text
//   yamlToJson(yamlText) : YAML text -> JSON text
//
// Bridging strategy (design.md "converters"): the forward direction parses the
// source JSON through `json-core`'s `parseJson`, so object key order is taken
// from the model (`js-yaml`'s `dump` emits keys in insertion order) and every
// key, value, nesting level, and value type is preserved (Req 13.1). Numbers
// are bridged as JS `number`s because `js-yaml` cannot serialize `bigint`;
// this matches the engine's own load side, which also reads YAML numbers as JS
// numbers, so the YAML round-trip (JSON→YAML→JSON) is faithful for every value
// YAML can represent (Req 13.7).
//
// The reverse direction loads the YAML into a plain value, sanitizes YAML-only
// constructs (timestamps become ISO 8601 strings) and emits JSON text via
// `lossless-json` (Req 13.6). Errors are returned as typed `ConverterResult`
// values with a 1-based line where the engine reports one (Req 13.10).

import { dump as dumpYaml, load as loadYaml, YAMLException } from 'js-yaml';
import {
  fail,
  modelToPlain,
  ok,
  parseSourceJson,
  plainToJsonText,
  sanitizeForJson,
  type ConverterResult,
} from './shared';

/**
 * Convert JSON source text to YAML text.
 *
 * Preserves all keys, values, nesting structure, and value data types of the
 * source model. Returns a typed error for empty input or invalid JSON.
 */
export function jsonToYaml(jsonText: string): ConverterResult {
  const parsed = parseSourceJson(jsonText);
  if ('ok' in parsed) {
    return parsed; // forward the parse error / empty-input error
  }

  // js-yaml cannot serialize bigint, so bridge numbers as JS numbers.
  const value = modelToPlain(parsed.model, /* useBigInt */ false);

  try {
    // `noRefs` avoids `&anchor`/`*alias` output for repeated references, keeping
    // the YAML a faithful, self-contained projection of the JSON tree.
    //
    // `forceQuotes` makes every string scalar emit in a quoted (flow) style
    // rather than a block scalar. This is required for faithful round-tripping:
    // js-yaml otherwise dumps a newline-only / pure-whitespace string (e.g.
    // "\n") as a `|+` block scalar that its own loader then rejects with
    // "missing indentation for block scalar". Quoted scalars escape such
    // content (e.g. `"\n"`) so the value re-parses reliably, while ordinary
    // strings, numbers, nesting, and types are unaffected (Req 13.1, 13.7).
    const text = dumpYaml(value, { noRefs: true, forceQuotes: true });
    return ok(text);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : 'Failed to convert JSON to YAML.',
    );
  }
}

/**
 * Convert YAML source text to JSON text.
 *
 * Preserves all keys, values, and nesting structure of the source. YAML
 * timestamps are rendered as ISO 8601 strings in the JSON output. Returns a
 * typed error (with a 1-based line where available) for empty or malformed
 * YAML.
 */
export function yamlToJson(yamlText: string): ConverterResult {
  if (yamlText.trim().length === 0) {
    return fail('Input is empty; there is no YAML to convert.');
  }

  let value: unknown;
  try {
    value = loadYaml(yamlText);
  } catch (error) {
    if (error instanceof YAMLException) {
      // js-yaml marks are 0-based; report a 1-based line.
      const line = error.mark ? error.mark.line + 1 : undefined;
      return fail(error.message, line === undefined ? undefined : { line });
    }
    return fail(
      error instanceof Error ? error.message : 'Failed to parse YAML.',
    );
  }

  if (value === undefined) {
    // A document consisting only of comments / whitespace.
    return fail('Input contains no YAML document to convert.');
  }

  return ok(plainToJsonText(sanitizeForJson(value)));
}
