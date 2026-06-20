// Feature: json-viewer-free
//
// Pure rich-media classification core (Req 12.1, 12.3, 12.4, 12.5).
//
// This module is the framework-free classification logic only: given a scalar
// JSON value it decides whether the value represents an image URL, a hex
// color, a non-image link, or a Unix timestamp — or nothing recognizable.
//
// It performs NO DOM work and renders NO previews. Visual presentation
// (image hover thumbnails, color swatches, activatable links, date
// annotations) is the responsibility of the `RichMedia` component (task 13.7).
// Keeping the decision logic pure makes it directly exercisable by the
// rich-media classification property (design Property 22).

/**
 * The result of classifying a scalar value for rich-media presentation.
 *
 * A discriminated union keyed by `kind`:
 *   - `image`     — an http(s) URL ending in a known image extension (Req 12.1).
 *   - `color`     — a `#` hex color of 3, 6, or 8 digits (Req 12.3).
 *   - `link`      — an http(s) URL that is not an image URL (Req 12.5).
 *   - `timestamp` — a number within the Unix-seconds range (Req 12.4); carries
 *                   the ISO 8601 rendering of that instant.
 *   - `none`      — the value matches no rich-media category.
 */
export type RichMediaClassification =
  | { kind: 'image'; url: string }
  | { kind: 'color'; color: string }
  | { kind: 'link'; url: string }
  | { kind: 'timestamp'; seconds: number; iso: string }
  | { kind: 'none' };

/** Shared "no classification" result. */
const NONE: RichMediaClassification = { kind: 'none' };

/**
 * Image file extensions recognized at the end of an http(s) URL (Req 12.1).
 * Matched case-insensitively.
 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

/**
 * Inclusive lower and upper bounds of the Unix timestamp range, interpreted as
 * seconds since 1970-01-01T00:00:00Z (Req 12.4).
 */
export const UNIX_TIMESTAMP_MIN_SECONDS = 0;
export const UNIX_TIMESTAMP_MAX_SECONDS = 4102444800;

/**
 * A `#` followed by exactly 3, 6, or 8 hexadecimal digits (case-insensitive),
 * anchored to the whole string (Req 12.3).
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** True when `value` begins with `http://` or `https://` (case-insensitive). */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** True when `value` ends (case-insensitively) with a known image extension. */
function hasImageExtension(value: string): boolean {
  const lower = value.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Classify a string value for rich-media presentation.
 *
 * Resolution order (each category is mutually exclusive given these rules):
 *   1. http(s) URL ending in an image extension  -> `image` (Req 12.1)
 *   2. any other http(s) URL                      -> `link`  (Req 12.5)
 *   3. `#` hex color of 3/6/8 digits              -> `color` (Req 12.3)
 *   4. otherwise                                   -> `none`
 */
export function classifyString(value: string): RichMediaClassification {
  if (isHttpUrl(value)) {
    return hasImageExtension(value)
      ? { kind: 'image', url: value }
      : { kind: 'link', url: value };
  }

  if (HEX_COLOR_PATTERN.test(value)) {
    return { kind: 'color', color: value };
  }

  return NONE;
}

/**
 * Classify a number value for rich-media presentation.
 *
 * A finite number within `[0, 4102444800]` inclusive is interpreted as Unix
 * epoch seconds and classified as a `timestamp`, carrying the ISO 8601
 * rendering of `new Date(seconds * 1000)` (Req 12.4). Any other number — out
 * of range, non-finite, or `NaN` — receives no classification.
 */
export function classifyNumber(value: number): RichMediaClassification {
  if (
    Number.isFinite(value) &&
    value >= UNIX_TIMESTAMP_MIN_SECONDS &&
    value <= UNIX_TIMESTAMP_MAX_SECONDS
  ) {
    return {
      kind: 'timestamp',
      seconds: value,
      iso: new Date(value * 1000).toISOString(),
    };
  }

  return NONE;
}

/**
 * Convenience entry point that dispatches by the runtime type of `value`.
 * Strings are routed to {@link classifyString} and numbers to
 * {@link classifyNumber}; every other value type receives no classification.
 */
export function classifyValue(value: unknown): RichMediaClassification {
  if (typeof value === 'string') {
    return classifyString(value);
  }
  if (typeof value === 'number') {
    return classifyNumber(value);
  }
  return NONE;
}
