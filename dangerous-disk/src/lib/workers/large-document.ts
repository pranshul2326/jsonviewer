// Feature: json-viewer-free — Task 19.1
//
// Large_Document detection — the single source of truth for the threshold that
// decides whether an operation runs synchronously on the main thread (for
// snappy feedback) or is dispatched to a Web Worker (to keep the UI responsive).
//
// Per the requirements glossary, a Large_Document is "a JSON document whose
// serialized size is 5 MB or greater" (Req 17.1). The design pins the boundary
// at 5 MB: "Small documents (< 5 MB) parse synchronously on the main thread for
// snappy feedback ... The main thread never parses a Large_Document inline; it
// dispatches to a worker and continues handling input" (Req 17.2).
//
// "Size" here is the UTF-8 byte length of the text (its serialized size), not
// the JavaScript string length, so multi-byte content is measured the way it is
// transmitted/stored.

/**
 * The Large_Document threshold in bytes (5 MB). A document whose UTF-8 byte
 * length is greater than or equal to this is processed off the main thread
 * (Req 17.1).
 */
export const LARGE_DOCUMENT_THRESHOLD_BYTES = 5_000_000;

/**
 * The UTF-8 byte length of `text`. Uses `TextEncoder` where available (browsers
 * and modern runtimes) and falls back to the character count otherwise, so the
 * check still works in minimal environments.
 */
export function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

/**
 * Whether `text` is a Large_Document (≥ 5 MB serialized), and therefore should
 * be processed in a Web Worker rather than on the main thread (Req 17.1).
 */
export function isLargeDocument(text: string): boolean {
  return byteLength(text) >= LARGE_DOCUMENT_THRESHOLD_BYTES;
}

/**
 * Whether ANY of the supplied document texts is a Large_Document. Used by the
 * multi-input tools (diff, patch, merge) to decide whether to route their heavy
 * compute through a worker (Req 17.1).
 */
export function isAnyLarge(...texts: string[]): boolean {
  return texts.some((text) => isLargeDocument(text));
}
