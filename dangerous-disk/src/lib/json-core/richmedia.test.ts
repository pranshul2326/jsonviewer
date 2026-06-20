// Feature: json-viewer-free, Property 22: Rich-media classification is correct per value space
//
// Validates: Requirements 12.1, 12.3, 12.4, 12.5
//
// Requirement contract under test (rich-media type inference, pure core):
//   12.1 — A string matching the image URL pattern (http(s):// ... ending in
//          .png/.jpg/.jpeg/.gif/.webp/.svg, case-insensitive) is an image URL.
//   12.5 — A string matching a non-image http(s) URL is an activatable link.
//   12.3 — A string matching the hex-color pattern (#, then exactly 3/6/8 hex
//          digits, case-insensitive) is a hex color.
//   12.4 — A number within the Unix timestamp range [0, 4102444800] inclusive
//          is a timestamp, rendered in ISO 8601 (seconds since the epoch).
//   (closure) — Any value matching none of these spaces gets no classification.
//
// Strategy
// --------
// Property 22 partitions the scalar value space into five mutually-exclusive
// regions and asserts the classifier lands in exactly the right region for
// each. Inputs are drawn from the shared rich-media arbitraries
// (`imageUrlArbitrary`, `hexColorArbitrary`, `timestampArbitrary`) plus two
// locally-defined generators for the remaining regions: non-image http(s) URLs
// (links) and values that fall outside every recognized space. Each property
// runs at >= 100 iterations.

import { describe } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import {
  classifyString,
  classifyNumber,
  classifyValue,
  UNIX_TIMESTAMP_MAX_SECONDS,
} from './richmedia';
import {
  imageUrlArbitrary,
  hexColorArbitrary,
  timestampArbitrary,
} from '../../test/arbitraries';

// Run every property well above the suite's >=100-iteration floor.
const RUNS = { numRuns: 100 } as const;

/** A run of [1, 10] URL-safe alphanumeric characters (never empty). */
const urlSegment = fc.string({ minLength: 1, maxLength: 10 }).map((raw) => {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '');
  return cleaned.length > 0 ? cleaned : 'seg';
});

/**
 * An http(s) URL that is deliberately NOT an image URL: it ends in a path
 * segment whose extension is never one of the recognized image extensions
 * (Req 12.5). The non-image suffix is fixed so the generator can never, by
 * chance, emit a string the image rule would claim.
 */
function nonImageUrlArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('http://', 'https://', 'HTTP://', 'HTTPS://'),
      urlSegment,
      fc.array(urlSegment, { maxLength: 3 }),
      fc.constantFrom(
        '',
        '/index.html',
        '/api/data.json',
        '/page',
        '/file.txt',
        '/style.css',
        '/download.pdf',
        '/photo.png.txt',
        '/',
      ),
    )
    .map(([scheme, host, segments, suffix]) => {
      const path = segments.length > 0 ? `/${segments.join('/')}` : '';
      return `${scheme}${host}.com${path}${suffix}`;
    });
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

/** True when `value` begins with http:// or https:// (case-insensitive). */
function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** True when `value` ends (case-insensitively) with a known image extension. */
function looksLikeImage(value: string): boolean {
  const lower = value.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** True when `value` is a #-prefixed hex color of 3/6/8 digits. */
function looksLikeHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

/**
 * A string that matches NONE of the recognized string spaces: not an http(s)
 * URL and not a hex color. The independent predicates above characterize the
 * three positive spaces, so filtering on their negation yields exactly the
 * "no classification" region without assuming the implementation's answer.
 */
function unrecognizedStringArbitrary(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.fullUnicodeString(),
      fc.string(),
      fc.constantFrom(
        '',
        ' ',
        'hello world',
        'ftp://example.com/image.png',
        'example.com/photo.png',
        'http:/missing-slash.png',
        '#12',
        '#xyz',
        '#1234567',
        '#1234567890',
        'png',
        '#',
        'mailto:user@example.com',
      ),
    )
    .filter((value) => !looksLikeHttpUrl(value) && !looksLikeHexColor(value));
}

/**
 * A number that falls OUTSIDE the Unix timestamp range: strictly negative,
 * strictly greater than the inclusive maximum, or non-finite (Req 12.4
 * closure). These must receive no classification.
 */
function nonTimestampNumberArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(
    fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .filter((n) => n < 0 || n > UNIX_TIMESTAMP_MAX_SECONDS),
    fc.constantFrom(
      -1,
      -0.0001,
      UNIX_TIMESTAMP_MAX_SECONDS + 1,
      UNIX_TIMESTAMP_MAX_SECONDS + 0.5,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ),
  );
}

describe('Property 22: Rich-media classification is correct per value space', () => {
  // ── Image URLs (Req 12.1) ────────────────────────────────────────────────
  test.prop([imageUrlArbitrary()], RUNS)(
    'image-pattern strings classify as image URL carrying the original value',
    (url) => {
      const result = classifyString(url);
      expect(result.kind).toBe('image');
      if (result.kind === 'image') {
        expect(result.url).toBe(url);
      }
      // classifyValue dispatches strings to the same answer.
      expect(classifyValue(url)).toEqual(result);
    },
  );

  // ── Non-image links (Req 12.5) ───────────────────────────────────────────
  test.prop([nonImageUrlArbitrary()], RUNS)(
    'non-image http(s) URLs classify as link carrying the original value',
    (url) => {
      // Guard: the generator must not accidentally emit an image URL.
      fc.pre(!looksLikeImage(url));
      const result = classifyString(url);
      expect(result.kind).toBe('link');
      if (result.kind === 'link') {
        expect(result.url).toBe(url);
      }
      expect(classifyValue(url)).toEqual(result);
    },
  );

  // ── Hex colors (Req 12.3) ────────────────────────────────────────────────
  test.prop([hexColorArbitrary()], RUNS)(
    'hex-color strings (#3/6/8 digits) classify as hex color',
    (color) => {
      const result = classifyString(color);
      expect(result.kind).toBe('color');
      if (result.kind === 'color') {
        expect(result.color).toBe(color);
      }
      expect(classifyValue(color)).toEqual(result);
    },
  );

  // ── Unix timestamps (Req 12.4) ───────────────────────────────────────────
  test.prop([timestampArbitrary()], RUNS)(
    'numbers in [0, 4102444800] classify as timestamp with ISO 8601 rendering',
    (seconds) => {
      const result = classifyNumber(seconds);
      expect(result.kind).toBe('timestamp');
      if (result.kind === 'timestamp') {
        expect(result.seconds).toBe(seconds);
        expect(result.iso).toBe(new Date(seconds * 1000).toISOString());
      }
      expect(classifyValue(seconds)).toEqual(result);
    },
  );

  // ── No classification: unrecognized strings ──────────────────────────────
  test.prop([unrecognizedStringArbitrary()], RUNS)(
    'strings outside every recognized space get no classification',
    (value) => {
      expect(classifyString(value).kind).toBe('none');
      expect(classifyValue(value).kind).toBe('none');
    },
  );

  // ── No classification: out-of-range / non-finite numbers ──────────────────
  test.prop([nonTimestampNumberArbitrary()], RUNS)(
    'numbers outside [0, 4102444800] (or non-finite) get no classification',
    (value) => {
      expect(classifyNumber(value).kind).toBe('none');
      expect(classifyValue(value).kind).toBe('none');
    },
  );
});
