// Feature: json-viewer-free
//
// Property-based tests for the Smart Fixer in `fixer.ts` (`smartFix`) together
// with `parseJson` and the `structuralEquals` oracle. Two design properties are
// covered:
//
//   Property 12: Smart Fixer always yields valid JSON equal to the intended
//                document.
//   Property 13: Smart Fixer correction summary counts are accurate.
//
// Inputs are drawn from the shared `deformedJsonArbitrary` in
// `src/test/arbitraries.ts`, which yields `{ model, deformed, counts }`: a valid
// JSON document, a deformed textual rendering of it (trailing commas, unquoted
// keys, and/or single-quote string delimiters, alone or combined), and the exact
// number of deformations introduced per correctable category.

import { describe } from 'vitest';
import { test } from '@fast-check/vitest';
import { smartFix } from './fixer';
import { parseJson } from './parse';
import type { JsonNode } from './types';
import { serialize } from './serialize';
import { deformedJsonArbitrary, jsonArbitrary, structuralEquals } from '../../test/arbitraries';

// At least 100 iterations per property (design requirement).
const RUNS = { numRuns: 100 } as const;

/**
 * Parse JSON text and return the model, failing loudly if the text was not
 * parsed into a (non-empty) model. The Smart Fixer's corrected output of any
 * generated document is always non-empty valid JSON, so the empty/error
 * branches here indicate a genuine defect.
 */
function parseToModel(text: string): JsonNode {
  const result = parseJson(text);
  if (!result.ok) {
    throw new Error(
      `expected valid JSON but parse failed: ${result.error.message}\n--- text ---\n${text}`,
    );
  }
  if (result.empty) {
    throw new Error(`expected a model but parse reported empty\n--- text ---\n${text}`);
  }
  return result.model;
}

describe('smartFix correctness and correction summary', () => {
  // Feature: json-viewer-free, Property 12: Smart Fixer always yields valid JSON
  // equal to the intended document. Validates: Requirements 7.1, 7.2, 7.3, 7.4,
  // 7.5, 7.8
  test.prop([deformedJsonArbitrary()], RUNS)(
    'Property 12: fixing a deformed document yields valid JSON structurally equal to the original',
    ({ model, deformed }) => {
      const result = smartFix(deformed);
      if (!result.ok) {
        throw new Error(
          `smartFix failed at line ${result.line}, column ${result.column}: ${result.message}\n--- deformed ---\n${deformed}`,
        );
      }

      // The corrected text must parse as valid JSON (Req 7.5, 7.8) ...
      const fixedModel = parseToModel(result.text);

      // ... and be structurally equivalent to the original undeformed document
      // (Req 7.1, 7.2, 7.3, 7.4).
      if (!structuralEquals(model, fixedModel)) {
        throw new Error(
          `fixed model differs from the original\n--- deformed ---\n${deformed}\n--- fixed ---\n${result.text}`,
        );
      }
      return true;
    },
  );

  // Feature: json-viewer-free, Property 13: Smart Fixer correction summary counts
  // are accurate. Validates: Requirements 7.6
  test.prop([deformedJsonArbitrary()], RUNS)(
    'Property 13: the correction summary counts each category exactly',
    ({ deformed, counts }) => {
      const result = smartFix(deformed);
      if (!result.ok) {
        throw new Error(
          `smartFix failed at line ${result.line}, column ${result.column}: ${result.message}\n--- deformed ---\n${deformed}`,
        );
      }

      const { summary } = result;
      if (summary.trailingCommas !== counts.trailingCommas) {
        throw new Error(
          `trailingCommas: reported ${summary.trailingCommas} !== introduced ${counts.trailingCommas}\n--- deformed ---\n${deformed}`,
        );
      }
      if (summary.unquotedKeys !== counts.unquotedKeys) {
        throw new Error(
          `unquotedKeys: reported ${summary.unquotedKeys} !== introduced ${counts.unquotedKeys}\n--- deformed ---\n${deformed}`,
        );
      }
      if (summary.singleQuotes !== counts.singleQuotes) {
        throw new Error(
          `singleQuotes: reported ${summary.singleQuotes} !== introduced ${counts.singleQuotes}\n--- deformed ---\n${deformed}`,
        );
      }
      return true;
    },
  );

  // Feature: json-viewer-free, Property 13: an already-valid document reports
  // that no corrections were needed (all-zero summary). Validates: Requirements 7.6
  test.prop([jsonArbitrary()], RUNS)(
    'Property 13: an already-valid document reports no corrections needed',
    (model) => {
      const result = smartFix(serialize(model));
      if (!result.ok) {
        throw new Error(`smartFix unexpectedly failed on valid input: ${result.message}`);
      }
      const { summary } = result;
      if (
        summary.trailingCommas !== 0 ||
        summary.unquotedKeys !== 0 ||
        summary.singleQuotes !== 0
      ) {
        throw new Error(
          `already-valid document reported corrections: ${JSON.stringify(summary)}`,
        );
      }
      return true;
    },
  );
});
