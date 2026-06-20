// Feature: json-viewer-free — Task 18.6
//
// Privacy integration tests (Req 18.1, 18.2, 18.4, 18.5).
//
// These tests verify the three load-bearing privacy guarantees of the app:
//
//   1. (Req 18.1, 18.2) Running representative core operations — parse, format,
//      minify, semantic diff, and conversion of a sample document — issues
//      ZERO network requests. A network spy overrides every browser network
//      primitive (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`,
//      `WebSocket`, `EventSource`) and records every invocation together with
//      its arguments. We assert none of them were called at all, and as an
//      extra guard that no recorded argument carries the unique sentinel value
//      embedded in the user's JSON.
//
//   2. (Req 18.5) The Content-Security-Policy declared in `Layout.astro`
//      includes the `connect-src 'self'` directive that blocks any accidental
//      outbound data call. Reading the layout source text is an acceptable way
//      to assert the policy is in place.
//
//   3. (Req 18.4) With every network primitive stubbed to throw (simulating a
//      device with no active network connection), the same core operations
//      still complete without error and return correct results — proving the
//      processing is entirely local.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseJson } from '../lib/json-core/parse';
import { format, minify } from '../lib/json-core/serialize';
import { semanticDiff } from '../lib/json-core/diff';
import { jsonToYaml } from '../lib/converters/yaml';

// ---------------------------------------------------------------------------
// Sample document with a unique sentinel so we can prove no user JSON escaped.
// ---------------------------------------------------------------------------

const SENTINEL = 'SENSITIVE_USER_VALUE_8f3a2b1c';

const sampleObject = {
  name: SENTINEL,
  nested: { id: 12345, tags: ['alpha', 'beta'], active: true, note: null },
  list: [1, 2, 3],
};

const SAMPLE_JSON = JSON.stringify(sampleObject);
const RIGHT_JSON = JSON.stringify({ ...sampleObject, name: `${SENTINEL}_changed` });

// ---------------------------------------------------------------------------
// Core operations under test (parse + format + minify + diff + convert).
// ---------------------------------------------------------------------------

interface CoreResults {
  formatted: string;
  minified: string;
  diffPaths: { path: string; kind: string }[];
  yamlText: string;
}

/**
 * Run a representative slice of the app's core operations against the sample
 * document. These are the pure, fully-local `json-core`/converter functions
 * that back the Viewer, Formatter, Diff Checker, and Converter tools — none of
 * them should ever touch the network.
 */
function runCoreOperations(json: string, rightJson: string): CoreResults {
  const parsed = parseJson(json);
  if (!parsed.ok || parsed.empty) {
    throw new Error('Expected the sample document to parse into a model.');
  }

  const formatted = format(parsed.model, { kind: 'space', size: 2 });
  const minified = minify(json);

  const rightParsed = parseJson(rightJson);
  if (!rightParsed.ok || rightParsed.empty) {
    throw new Error('Expected the right document to parse into a model.');
  }

  const diffs = semanticDiff(parsed.model, rightParsed.model);

  const yaml = jsonToYaml(json);
  if (!yaml.ok) {
    throw new Error('Expected JSON→YAML conversion to succeed.');
  }

  return {
    formatted,
    minified,
    diffPaths: diffs.map((d) => ({ path: d.path, kind: d.kind })),
    yamlText: yaml.text,
  };
}

/** Assert the core operations produced correct, complete results. */
function expectCorrectResults(results: CoreResults): void {
  // Formatting round-trips and retains the user's data.
  const reparsed = parseJson(results.formatted);
  expect(reparsed.ok).toBe(true);
  expect(results.formatted).toContain(SENTINEL);

  // Minify strips insignificant whitespace but keeps the data.
  expect(results.minified).toContain(SENTINEL);
  expect(results.minified).not.toMatch(/\n/);

  // The only structural change between the two documents is the `name` value.
  expect(results.diffPaths).toEqual([{ path: '/name', kind: 'modification' }]);

  // The YAML projection still contains the data.
  expect(results.yamlText).toContain(SENTINEL);
}

// ---------------------------------------------------------------------------
// Network spy: override every browser network primitive.
// ---------------------------------------------------------------------------

interface NetworkCall {
  api: string;
  args: unknown[];
}

type NetworkMode = 'record' | 'offline';

interface NetworkSpy {
  calls: NetworkCall[];
  restore: () => void;
}

const NETWORK_APIS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
] as const;

/**
 * Install a spy over the network primitives.
 *
 *   - `'record'` mode records each invocation (and its arguments) and returns a
 *     benign no-op result, so any stray network use is caught without crashing.
 *   - `'offline'` mode makes every primitive throw on use, simulating a device
 *     with no active network connection (Req 18.4).
 */
function installNetworkSpy(mode: NetworkMode): NetworkSpy {
  const calls: NetworkCall[] = [];
  const g = globalThis as Record<string, unknown>;

  // Preserve originals (using a sentinel for "did not previously exist").
  const MISSING = Symbol('missing');
  const saved: Record<string, unknown> = {};
  for (const api of NETWORK_APIS) {
    saved[api] = api in g ? g[api] : MISSING;
  }
  const nav = (globalThis as { navigator?: { sendBeacon?: unknown } }).navigator;
  const savedSendBeacon =
    nav && 'sendBeacon' in nav ? nav.sendBeacon : MISSING;

  const offline = (api: string): never => {
    throw new Error(`Network unavailable (offline): ${api} blocked`);
  };

  // --- fetch -------------------------------------------------------------
  g.fetch = (...args: unknown[]): unknown => {
    calls.push({ api: 'fetch', args });
    if (mode === 'offline') return offline('fetch');
    return Promise.resolve({ ok: true, status: 200 });
  };

  // --- XMLHttpRequest ----------------------------------------------------
  class SpyXHR {
    open(...args: unknown[]): void {
      calls.push({ api: 'XMLHttpRequest.open', args });
      if (mode === 'offline') offline('XMLHttpRequest.open');
    }
    send(...args: unknown[]): void {
      calls.push({ api: 'XMLHttpRequest.send', args });
      if (mode === 'offline') offline('XMLHttpRequest.send');
    }
    setRequestHeader(): void {}
    abort(): void {}
    addEventListener(): void {}
  }
  g.XMLHttpRequest = SpyXHR;

  // --- WebSocket ---------------------------------------------------------
  class SpyWebSocket {
    constructor(...args: unknown[]) {
      calls.push({ api: 'WebSocket', args });
      if (mode === 'offline') offline('WebSocket');
    }
    send(): void {}
    close(): void {}
  }
  g.WebSocket = SpyWebSocket;

  // --- EventSource -------------------------------------------------------
  class SpyEventSource {
    constructor(...args: unknown[]) {
      calls.push({ api: 'EventSource', args });
      if (mode === 'offline') offline('EventSource');
    }
    close(): void {}
  }
  g.EventSource = SpyEventSource;

  // --- navigator.sendBeacon ---------------------------------------------
  if (nav) {
    nav.sendBeacon = (...args: unknown[]): boolean => {
      calls.push({ api: 'navigator.sendBeacon', args });
      if (mode === 'offline') offline('navigator.sendBeacon');
      return true;
    };
  }

  const restore = (): void => {
    for (const api of NETWORK_APIS) {
      if (saved[api] === MISSING) {
        delete g[api];
      } else {
        g[api] = saved[api];
      }
    }
    if (nav) {
      if (savedSendBeacon === MISSING) {
        delete (nav as { sendBeacon?: unknown }).sendBeacon;
      } else {
        (nav as { sendBeacon?: unknown }).sendBeacon = savedSendBeacon;
      }
    }
  };

  return { calls, restore };
}

/** Recursively scan a value for the sentinel string. */
function containsSentinel(value: unknown, sentinel: string): boolean {
  if (typeof value === 'string') return value.includes(sentinel);
  if (value instanceof URL) return value.href.includes(sentinel);
  if (Array.isArray(value)) {
    return value.some((item) => containsSentinel(item, sentinel));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsSentinel(v, sentinel),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let activeSpy: NetworkSpy | undefined;

afterEach(() => {
  activeSpy?.restore();
  activeSpy = undefined;
});

describe('Client-side privacy (Req 18)', () => {
  it('issues zero network requests during representative core operations (Req 18.1, 18.2)', () => {
    const spy = installNetworkSpy('record');
    activeSpy = spy;

    const results = runCoreOperations(SAMPLE_JSON, RIGHT_JSON);

    // The operations must have actually run and produced correct output.
    expectCorrectResults(results);

    // No network primitive was invoked at all.
    expect(spy.calls).toHaveLength(0);

    // Defense in depth: even if some call had slipped through, none of the
    // recorded arguments may carry the user's JSON sentinel.
    const leaks = spy.calls.filter((call) =>
      call.args.some((arg) => containsSentinel(arg, SENTINEL)),
    );
    expect(leaks).toEqual([]);
  });

  it('declares a Content-Security-Policy with connect-src \'self\' (Req 18.5)', () => {
    // Vitest runs with the `dangerous-disk` package root as the working
    // directory, so the layout resolves relative to it.
    const layoutPath = resolve(process.cwd(), 'src/layouts/Layout.astro');
    const source = readFileSync(layoutPath, 'utf8');

    // The load-bearing directive blocking outbound data calls.
    expect(source).toContain("connect-src 'self'");

    // The directive must live inside the `csp` constant that feeds the
    // Content-Security-Policy <meta> tag (not merely in a comment).
    const cspMatch = source.match(/const csp = \[([\s\S]*?)\]\.join/);
    expect(cspMatch).not.toBeNull();
    expect(cspMatch?.[1]).toContain("connect-src 'self'");

    // The CSP is wired to the actual meta tag.
    expect(source).toContain(
      '<meta http-equiv="Content-Security-Policy" content={csp} />',
    );
  });

  it('completes all core operations correctly with no network connection (Req 18.4)', () => {
    const spy = installNetworkSpy('offline');
    activeSpy = spy;

    // With every network primitive stubbed to throw, the pure local operations
    // must still complete and return correct results.
    let results: CoreResults | undefined;
    expect(() => {
      results = runCoreOperations(SAMPLE_JSON, RIGHT_JSON);
    }).not.toThrow();

    expect(results).toBeDefined();
    expectCorrectResults(results as CoreResults);

    // And the local operations genuinely never reached for the network.
    expect(spy.calls).toHaveLength(0);
  });
});
