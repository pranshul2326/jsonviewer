// Feature: json-viewer-free — Task 19.2
//
// Performance benchmark tests for the pure `json-core` / converter / query
// layers, asserting the processing ceilings the requirements demand:
//
//   • Req 5.9  — format / minify of valid JSON up to 5,000,000 characters
//                completes within 3 seconds.
//   • Req 13.9 — conversion (JSON → YAML) of a source document up to 5 MB
//                completes within 2 seconds.
//   • Req 16.1 / 16.2 — JSONPath and JMESPath evaluation against a document up
//                to 50 MB completes within 2 seconds.
//
// These bounds are the actual requirement thresholds, not weakened proxies:
// the work runs entirely in-process (the same pure functions the Web Workers
// call), so the measured wall-clock time is a faithful lower bound on the
// real operation cost. The large documents are generated programmatically so
// the test is deterministic and carries no fixtures. Timings are surfaced via
// the test runner's stderr so regressions are visible in CI logs.
//
// Note on environment sensitivity: a heavily loaded or constrained CI runner
// can inflate these numbers. The thresholds below are the requirement bounds;
// if a runner genuinely cannot meet them the test will fail loudly (with the
// measured time) rather than silently relaxing the requirement.

import { describe, expect, it } from 'vitest';

import { parseJson } from '../lib/json-core/parse';
import { format, minify } from '../lib/json-core/serialize';
import { jsonToYaml } from '../lib/converters/yaml';
import { runQuery } from '../lib/query/engine';

// ---------------------------------------------------------------------------
// Deterministic large-document generators.
// ---------------------------------------------------------------------------

/**
 * Build a valid JSON array-of-objects string whose UTF-8 size is at least
 * `targetBytes`. Each element is a small, representative record (scalars,
 * a nested object, and a small array) so the document exercises every value
 * type a real payload would. Generation streams substrings into one array and
 * joins once, keeping peak memory close to the final string size.
 */
function makeLargeJsonArray(targetBytes: number): string {
  const parts: string[] = [];
  let size = 2; // for the surrounding '[' and ']'
  let i = 0;
  while (size < targetBytes) {
    const obj =
      `{"id":${i},` +
      `"name":"item-${i}",` +
      `"active":${i % 2 === 0},` +
      `"score":${(i * 1.5).toFixed(2)},` +
      `"tags":["alpha","beta","gamma"],` +
      `"nested":{"x":${i},"y":${i * 2},"label":"node-${i}"}}`;
    parts.push(obj);
    size += obj.length + 1; // + 1 for the joining comma
    i++;
  }
  return '[' + parts.join(',') + ']';
}

/** Report a byte count as a human-friendly MB string. */
function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/** UTF-8 byte length of a string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Time a synchronous operation, returning its result and elapsed ms. */
function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { result, ms };
}

// Document-size targets (the requirement ceilings).
const FIVE_MB = 5_000_000;
const FIFTY_MB = 50_000_000;

// Requirement time budgets, in milliseconds.
const FORMAT_MINIFY_BUDGET_MS = 3_000; // Req 5.9
const CONVERT_BUDGET_MS = 2_000; // Req 13.9
const QUERY_BUDGET_MS = 2_000; // Req 16.1, 16.2

describe('Performance ceilings (Req 5.9, 13.9, 16.1, 16.2)', () => {
  it('formats and minifies a ~5 MB document within 3 seconds (Req 5.9)', () => {
    const text = makeLargeJsonArray(FIVE_MB);
    const inputBytes = byteLength(text);
    expect(inputBytes).toBeGreaterThanOrEqual(FIVE_MB);

    // Formatting requires a parsed model; the end-to-end "format" operation a
    // user requests is parse + format, so we measure both together.
    const parse = timed(() => parseJson(text));
    expect(parse.result.ok).toBe(true);
    if (!parse.result.ok || parse.result.empty) {
      throw new Error('Expected the generated 5 MB document to parse.');
    }
    const model = parse.result.model;

    const formatRun = timed(() => format(model, { kind: 'space', size: 2 }));
    const formatTotalMs = parse.ms + formatRun.ms;

    // Minify operates directly on the text (string-literal-aware scanner).
    const minifyRun = timed(() => minify(text));

    // eslint-disable-next-line no-console
    console.error(
      `[perf] format/minify @ ${mb(inputBytes)}: ` +
        `parse=${parse.ms.toFixed(0)}ms, format=${formatRun.ms.toFixed(0)}ms ` +
        `(parse+format=${formatTotalMs.toFixed(0)}ms), ` +
        `minify=${minifyRun.ms.toFixed(0)}ms ` +
        `[budget ${FORMAT_MINIFY_BUDGET_MS}ms]`,
    );

    // Both transforms produced non-empty, larger/smaller output respectively.
    expect(formatRun.result.length).toBeGreaterThan(0);
    expect(minifyRun.result.length).toBeGreaterThan(0);
    expect(minifyRun.result.length).toBeLessThanOrEqual(inputBytes);

    expect(formatTotalMs).toBeLessThan(FORMAT_MINIFY_BUDGET_MS);
    expect(minifyRun.ms).toBeLessThan(FORMAT_MINIFY_BUDGET_MS);
  });

  it('converts a ~5 MB JSON document to YAML within 2 seconds (Req 13.9)', () => {
    const text = makeLargeJsonArray(FIVE_MB);
    const inputBytes = byteLength(text);
    expect(inputBytes).toBeGreaterThanOrEqual(FIVE_MB);

    // jsonToYaml parses the source and emits YAML end-to-end.
    const run = timed(() => jsonToYaml(text));

    // eslint-disable-next-line no-console
    console.error(
      `[perf] JSON→YAML @ ${mb(inputBytes)}: ${run.ms.toFixed(0)}ms ` +
        `[budget ${CONVERT_BUDGET_MS}ms]`,
    );

    expect(run.result.ok).toBe(true);
    if (run.result.ok) {
      expect(run.result.text.length).toBeGreaterThan(0);
    }
    expect(run.ms).toBeLessThan(CONVERT_BUDGET_MS);
  });

  it('evaluates a JSONPath query over a ~50 MB document within 2 seconds (Req 16.1)', () => {
    const text = makeLargeJsonArray(FIFTY_MB);
    const inputBytes = byteLength(text);
    expect(inputBytes).toBeGreaterThanOrEqual(FIFTY_MB);

    // A representative extraction: pull a scalar field from every element.
    // runQuery parses the document and evaluates the expression end-to-end.
    const run = timed(() => runQuery(text, '$[*].name', 'jsonpath'));

    // eslint-disable-next-line no-console
    console.error(
      `[perf] JSONPath @ ${mb(inputBytes)}: ${run.ms.toFixed(0)}ms ` +
        `[budget ${QUERY_BUDGET_MS}ms]`,
    );

    expect(run.result.ok).toBe(true);
    if (run.result.ok) {
      expect(run.result.results.length).toBeGreaterThan(0);
    }
    expect(run.ms).toBeLessThan(QUERY_BUDGET_MS);
  });

  it('evaluates a JMESPath query over a ~50 MB document within 2 seconds (Req 16.2)', () => {
    const text = makeLargeJsonArray(FIFTY_MB);
    const inputBytes = byteLength(text);
    expect(inputBytes).toBeGreaterThanOrEqual(FIFTY_MB);

    // The JMESPath equivalent of the extraction above.
    const run = timed(() => runQuery(text, '[*].name', 'jmespath'));

    // eslint-disable-next-line no-console
    console.error(
      `[perf] JMESPath @ ${mb(inputBytes)}: ${run.ms.toFixed(0)}ms ` +
        `[budget ${QUERY_BUDGET_MS}ms]`,
    );

    expect(run.result.ok).toBe(true);
    if (run.result.ok) {
      expect(run.result.results.length).toBeGreaterThan(0);
    }
    expect(run.ms).toBeLessThan(QUERY_BUDGET_MS);
  });
});
