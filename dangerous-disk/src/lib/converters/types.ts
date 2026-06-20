// Feature: json-viewer-free
//
// Shared result types for the format converters (YAML, XML, CSV, TOML).
//
// Every converter returns the same discriminated union so the Converter panel
// (Req 13.4, 13.10) can render success and failure uniformly: on failure it
// shows a descriptive message and, where determinable, the location (line or
// path) of the offending content, and it leaves the source unchanged.

/** A descriptive converter error (Req 13.4, 13.10). */
export interface ConvertError {
  /** Human-readable explanation of why the conversion failed. */
  message: string;
  /** 1-based line number of the offending content, where determinable. */
  line?: number;
  /** JSON_Path (or path-like locator) of the offending content, where determinable. */
  path?: string;
}

/**
 * The outcome of a conversion.
 *
 *   - `{ ok: true, text }` — the converted output text.
 *   - `{ ok: false, error }` — a descriptive error with an optional location;
 *     no partial output is produced (Req 13.4).
 */
export type ConvertResult =
  | { ok: true; text: string }
  | { ok: false; error: ConvertError };
