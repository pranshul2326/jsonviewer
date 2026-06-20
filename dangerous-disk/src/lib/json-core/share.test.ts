// Feature: json-viewer-free
//
// Property-based test for the share-link codec in `share.ts`
// (`encodeShare` / `decodeShare`) — the byte-preserving URL-sharing codec
// (Req 20).
//
// Covered design property:
//
//   Property 30: Share-link round-trip preserves the payload exactly.
//
// The codec compresses the raw JSON *text* bytes (rather than a re-serialized
// model), so a successful round-trip must recover the original characters
// byte-for-byte — that is the strongest possible statement of "preserving
// object key order, array element order, value types, and numeric precision"
// (Req 20.6). We assert both the byte-exact text recovery and tool recovery
// (Req 20.1, 20.5) AND, redundantly, that the parsed models are structurally
// equivalent (the wording of Property 30).
//
// Inputs are drawn from the shared arbitraries in `src/test/arbitraries.ts`
// (deep nesting, edge-y strings, big/high-precision numbers) and paired with a
// tool identifier biased toward the four real tools (Req 21.1) plus edge-y
// strings to exercise the tool encode/decode path.

import { describe } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { decodeShare, encodeShare } from './share';
import { serialize } from './serialize';
import { parseJson } from './parse';
import type { JsonNode } from './types';
import {
  edgyStringArbitrary,
  jsonArbitrary,
  structuralEquals,
} from '../../test/arbitraries';

// At least 100 iterations (design requirement).
const RUNS = { numRuns: 100 } as const;

/**
 * Tool identifiers: the four real tools (Req 21.1) plus edge-y strings, so the
 * `encodeURIComponent`/`decodeURIComponent` tool path is exercised for unusual
 * characters too.
 */
function toolArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constantFrom('viewer', 'diff', 'grid', 'converter'),
    edgyStringArbitrary(),
  );
}

/**
 * Parse JSON text into its model, failing loudly if it is not valid non-empty
 * JSON. Every serialized generated model is valid non-empty JSON, so the
 * error/empty branches here would indicate a genuine codec or emitter defect.
 */
function parseToModel(text: string): JsonNode {
  const result = parseJson(text);
  if (!result.ok) {
    throw new Error(
      `expected valid JSON but parse failed: ${result.error.message}\n--- text ---\n${text}`,
    );
  }
  if (result.empty) {
    throw new Error(
      `expected a model but parse reported empty\n--- text ---\n${text}`,
    );
  }
  return result.model;
}

describe('Property 30: Share-link round-trip preserves the payload exactly (Req 20.1, 20.5, 20.6)', () => {
  // Feature: json-viewer-free, Property 30: Share-link round-trip preserves the
  // payload exactly. Validates: Requirements 20.1, 20.5, 20.6
  test.prop([jsonArbitrary(), toolArbitrary()], RUNS)(
    'encodeShare then decodeShare recovers the exact text and tool',
    (model, tool) => {
      const text = serialize(model);

      // Encoding a valid, in-size payload must succeed (Req 20.1). These
      // generated documents are tiny, so the too-large branch never applies.
      const encoded = encodeShare(text, tool);
      if (!encoded.ok) {
        throw new Error(
          `encodeShare rejected a valid payload (reason: ${encoded.reason})\n--- text ---\n${text}`,
        );
      }

      // Decoding the hash must succeed (Req 20.5).
      const decoded = decodeShare(encoded.hash);
      if (!decoded.ok) {
        throw new Error(
          `decodeShare failed on a freshly encoded hash\n--- hash ---\n${encoded.hash}`,
        );
      }

      // The active tool round-trips exactly (Req 20.1, 20.5).
      if (decoded.tool !== tool) {
        throw new Error(
          `tool changed across round-trip: ${JSON.stringify(
            tool,
          )} -> ${JSON.stringify(decoded.tool)}`,
        );
      }

      // Byte-exact text recovery: the codec never re-renders the payload, so
      // every character — key order, array order, value types, and numeric
      // precision — is preserved verbatim (Req 20.6).
      if (decoded.text !== text) {
        throw new Error(
          `text changed across round-trip\n--- original ---\n${text}\n--- decoded ---\n${decoded.text}`,
        );
      }

      // Redundant model-equivalence check matching the Property 30 wording: the
      // decoded text parses to a model structurally equal to the original.
      const reparsed = parseToModel(decoded.text);
      if (!structuralEquals(model, reparsed)) {
        throw new Error(
          `round-trip changed the model\n--- decoded text ---\n${decoded.text}`,
        );
      }

      return true;
    },
  );
});
