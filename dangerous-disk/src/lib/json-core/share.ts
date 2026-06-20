// Feature: json-viewer-free
//
// `encodeShare` / `decodeShare` — the byte-preserving codec behind URL sharing
// (Req 20).
//
// Design (see design.md "Share-Link Model (Req 20)" and Property 30):
//   - `encodeShare(jsonText, tool)` rejects empty or invalid JSON (Req 20.2),
//     DEFLATE-compresses the *raw* UTF-8 bytes of the text with `fflate`,
//     base64url-encodes the result, and assembles a hash string carrying a
//     scheme-version + active-tool prefix. If the resulting encoded string
//     exceeds 2,000,000 characters it is rejected as too-large (Req 20.3).
//   - `decodeShare(hash)` reverses the process — strip the version/tool prefix,
//     base64url-decode, inflate, and validate the bytes parse as JSON (Req
//     20.7) — returning the active tool and the recovered text.
//
// The codec deliberately operates on the JSON *text* rather than a re-serialized
// model, so the round-trip is byte-exact: object key order, array order, value
// types, and numeric precision are preserved because the original characters are
// never re-rendered (Req 20.6, Property 30).
//
// base64url and UTF-8 conversion are implemented without relying on `btoa`/
// `atob`, so the codec behaves identically in the browser, in Node, and under
// jsdom in tests.

import { deflateSync, inflateSync } from 'fflate';
import { parseJson } from './parse';

/** Scheme version embedded in the payload so future formats stay decodable. */
const SHARE_SCHEME_VERSION = '1';

/** Maximum length, in characters, of the encoded hash string (Req 20.3). */
const MAX_ENCODED_LENGTH = 2_000_000;

/** Separator between the scheme version and the base64url payload. */
const VERSION_SEPARATOR = '.';

/**
 * The outcome of encoding a share link.
 *
 *   - `{ ok: true, hash }` — the encoded hash string, *without* the leading `#`.
 *   - `{ ok: false, reason: 'invalid' }` — empty or invalid JSON (Req 20.2).
 *   - `{ ok: false, reason: 'too-large' }` — encoded form exceeds the limit
 *     (Req 20.3).
 */
export type ShareEncodeResult =
  | { ok: true; hash: string }
  | { ok: false; reason: 'invalid' | 'too-large' };

/**
 * The outcome of decoding a share link.
 *
 *   - `{ ok: true, tool, text }` — the recovered active tool and the
 *     byte-exact JSON text (Req 20.5, 20.6).
 *   - `{ ok: false }` — the hash could not be decoded into valid JSON
 *     (Req 20.7).
 */
export type ShareDecodeResult =
  | { ok: true; tool: string; text: string }
  | { ok: false };

/**
 * Encode `jsonText` and the active `tool` into a shareable hash string.
 *
 * Empty/whitespace-only or syntactically invalid JSON is rejected as
 * `'invalid'`. Otherwise the raw text bytes are DEFLATE-compressed,
 * base64url-encoded, and assembled as `tool=<tool>&d=<version>.<payload>`.
 * If that string would exceed {@link MAX_ENCODED_LENGTH} characters the result
 * is `'too-large'`. The returned `hash` omits the leading `#`.
 */
export function encodeShare(jsonText: string, tool: string): ShareEncodeResult {
  // Reject empty or invalid JSON before doing any work (Req 20.2).
  const parsed = parseJson(jsonText);
  if (!parsed.ok || parsed.empty) {
    return { ok: false, reason: 'invalid' };
  }

  // Compress the raw text bytes (byte-preserving) and base64url-encode them.
  const bytes = new TextEncoder().encode(jsonText);
  const compressed = deflateSync(bytes);
  const payload = bytesToBase64Url(compressed);

  // Assemble the hash with a version + active-tool prefix.
  const hash =
    `tool=${encodeURIComponent(tool)}` +
    `&d=${SHARE_SCHEME_VERSION}${VERSION_SEPARATOR}${payload}`;

  // Reject if the encoded string is too large to share (Req 20.3).
  if (hash.length > MAX_ENCODED_LENGTH) {
    return { ok: false, reason: 'too-large' };
  }

  return { ok: true, hash };
}

/**
 * Decode a share `hash` back into its active tool and JSON text.
 *
 * Accepts a hash with or without a leading `#`. Reverses
 * {@link encodeShare}: parse the `tool`/`d` fields, strip and verify the scheme
 * version, base64url-decode, inflate, and confirm the bytes parse as valid JSON
 * (Req 20.7). Any failure along the way yields `{ ok: false }`.
 */
export function decodeShare(hash: string): ShareDecodeResult {
  try {
    const params = parseHashParams(hash);
    const rawTool = params.get('tool');
    const rawData = params.get('d');
    if (rawTool === undefined || rawData === undefined) {
      return { ok: false };
    }

    // Strip and verify the scheme-version prefix.
    const separatorIndex = rawData.indexOf(VERSION_SEPARATOR);
    if (separatorIndex < 0) {
      return { ok: false };
    }
    const version = rawData.slice(0, separatorIndex);
    if (version !== SHARE_SCHEME_VERSION) {
      return { ok: false };
    }
    const payload = rawData.slice(separatorIndex + 1);

    // base64url-decode and inflate back to the original text bytes.
    const compressed = base64UrlToBytes(payload);
    const bytes = inflateSync(compressed);
    const text = new TextDecoder().decode(bytes);

    // Validate the recovered text is actually JSON (Req 20.7).
    const parsed = parseJson(text);
    if (!parsed.ok || parsed.empty) {
      return { ok: false };
    }

    return { ok: true, tool: decodeURIComponent(rawTool), text };
  } catch {
    // Malformed base64url, corrupt DEFLATE stream, bad UTF-8, etc. (Req 20.7).
    return { ok: false };
  }
}

/**
 * Parse an `a=b&c=d` hash fragment into a map. A leading `#` is tolerated and
 * stripped. Later occurrences of a key win, matching URLSearchParams' `get`.
 */
function parseHashParams(hash: string): Map<string, string> {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new Map<string, string>();
  for (const pair of body.split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const eq = pair.indexOf('=');
    if (eq < 0) {
      params.set(pair, '');
    } else {
      params.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  return params;
}

/** The url-safe base64 alphabet (RFC 4648 §5), used without padding. */
const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Reverse lookup: char code -> 6-bit value, or `-1` for non-alphabet chars. */
const BASE64URL_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    table[BASE64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Encode bytes as unpadded base64url. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64URL_ALPHABET[(triple >> 18) & 63] +
      BASE64URL_ALPHABET[(triple >> 12) & 63] +
      BASE64URL_ALPHABET[(triple >> 6) & 63] +
      BASE64URL_ALPHABET[triple & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const triple = bytes[i] << 16;
    out +=
      BASE64URL_ALPHABET[(triple >> 18) & 63] +
      BASE64URL_ALPHABET[(triple >> 12) & 63];
  } else if (remaining === 2) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      BASE64URL_ALPHABET[(triple >> 18) & 63] +
      BASE64URL_ALPHABET[(triple >> 12) & 63] +
      BASE64URL_ALPHABET[(triple >> 6) & 63];
  }
  return out;
}

/**
 * Decode unpadded base64url into bytes. Throws on any character outside the
 * alphabet so corrupt payloads surface as a decode failure.
 */
function base64UrlToBytes(text: string): Uint8Array {
  const outLength = Math.floor((text.length * 6) / 8);
  const bytes = new Uint8Array(outLength);
  let buffer = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? BASE64URL_LOOKUP[code] : -1;
    if (value < 0) {
      throw new Error('Invalid base64url character');
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[pos++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}
