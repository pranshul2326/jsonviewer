// Feature: json-viewer-free
//
// JSON <-> XML converter (Req 13.2, 13.6) built on `fast-xml-parser`.
//
//   - `jsonToXml` emits XML with a SINGLE root element (`<root>`). Each object
//     key becomes a child element; scalar values become element text content;
//     arrays repeat the element; nested objects nest elements — preserving the
//     source structure (Req 13.2).
//   - `xmlToJson` parses XML back to JSON text, unwrapping the single root
//     element so a JSON -> XML -> JSON round-trip recovers the original shape
//     (Req 13.6). XML always has exactly one root element, so unwrapping that
//     one level is well-defined.
//
// SECURITY NOTE (fast-xml-parser 4.5.x advisory — XML comment/CDATA injection
// in XMLBuilder): the builder is configured conservatively. We rely entirely on
// the library's default entity escaping (`processEntities: true`) and we do NOT
// enable comment or CDATA passthrough (`commentPropName` / `cdataPropName` are
// left unset). As a result, untrusted JSON content is always emitted as escaped
// text and can never be promoted into raw XML comments or CDATA sections.

import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseJson } from '../json-core/parse';
import type { ConvertResult } from './types';

/** The conventional single root element name used for JSON -> XML (Req 13.2). */
const ROOT_TAG = 'root';

/**
 * Builder configured conservatively per the security note above:
 *   - `processEntities: true` (default) escapes `& < > " '` in text content.
 *   - `commentPropName` / `cdataPropName` are intentionally unset so no input
 *     value can be emitted as a raw comment or CDATA section.
 */
const builder = new XMLBuilder({
  format: true,
  indentBy: '  ',
  ignoreAttributes: true,
  suppressEmptyNode: false,
  processEntities: true,
});

/**
 * Parser configured to mirror the builder. Attributes are ignored, scalar text
 * is type-coerced (`parseTagValue`), and entities are decoded. Comment/CDATA
 * preservation is left off, matching the builder's conservative output.
 */
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  processEntities: true,
});

/**
 * Convert JSON `jsonText` to XML with a single `<root>` element (Req 13.2).
 *
 * The input is validated with the shared Validator first; invalid or empty
 * input yields a descriptive error and no output (the source is left unchanged
 * by the caller).
 */
export function jsonToXml(jsonText: string): ConvertResult {
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
    return { ok: false, error: { message: 'There is no JSON to convert to XML.' } };
  }

  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, error: { message: messageOf(error, 'Could not read the JSON input.') } };
  }

  try {
    // Wrap the document under a single root element (Req 13.2). The library
    // escapes all text content; no raw comment/CDATA is ever produced.
    const xml = builder.build({ [ROOT_TAG]: value });
    return { ok: true, text: typeof xml === 'string' ? xml.trimEnd() : String(xml) };
  } catch (error) {
    return { ok: false, error: { message: messageOf(error, 'Could not build XML from the JSON input.') } };
  }
}

/**
 * Convert XML `xmlText` to JSON text (Req 13.6).
 *
 * The single root element is unwrapped so the result mirrors the original JSON
 * structure for a JSON -> XML -> JSON round-trip. Malformed XML yields a
 * descriptive error with the offending line where the validator reports one.
 */
export function xmlToJson(xmlText: string): ConvertResult {
  if (xmlText.trim().length === 0) {
    return { ok: false, error: { message: 'There is no XML to convert to JSON.' } };
  }

  // Validate first so malformed XML produces a precise, located error.
  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    const err = validation.err;
    return {
      ok: false,
      error: {
        message: `Input is not valid XML: ${err.msg}`,
        line: err.line,
      },
    };
  }

  let parsedXml: Record<string, unknown>;
  try {
    parsedXml = parser.parse(xmlText) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: { message: messageOf(error, 'Could not parse the XML input.') } };
  }

  // XML always has exactly one root element; unwrap it so the JSON mirrors the
  // original document shape (Req 13.6). If somehow absent, fall back to the
  // parsed object as-is.
  const keys = Object.keys(parsedXml);
  const unwrapped = keys.length === 1 ? parsedXml[keys[0]] : parsedXml;

  try {
    return { ok: true, text: JSON.stringify(unwrapped, null, 2) };
  } catch (error) {
    return { ok: false, error: { message: messageOf(error, 'Could not serialize the converted JSON.') } };
  }
}

/** Extract a message from an unknown error, falling back to `fallback`. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
