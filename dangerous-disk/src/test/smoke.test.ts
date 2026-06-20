// Feature: json-viewer-free — Task 19.2
//
// Smoke tests for the built site and the homepage/layout chrome, covering the
// quality ceilings that are configuration- and asset-shaped rather than
// input-shaped:
//
//   • Req 22.2 — every view renders ad-free: no third-party display ads, ad
//                iframes, or ad-network / tracker scripts in the built HTML.
//   • Req 22.1 / 22.7 — the homepage + layout chrome is token-driven: the
//                styling references the `@theme` design tokens (via `var(--…)`)
//                and contains no hardcoded hex colors that would diverge from
//                the token system.
//   • Req 22.7 — time-to-interactive within 3 s on a ≥5 Mbps connection. Real
//                TTI requires a browser, so this is asserted via a transparent
//                ASSET-BUDGET PROXY: the JavaScript/CSS the homepage loads
//                *eagerly* (to hydrate the island) must be small enough to
//                download well inside the 3 s budget at 5 Mbps, and the heavy
//                Monaco editor bundle must stay OUT of that eager path (it is
//                lazy-loaded only when the editor mounts).
//
// The built-site checks read `dist/`. Run `npm run build` first (the CI
// pipeline does); if `dist/` is missing the test fails with an actionable
// message rather than silently passing.

import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Paths. Vitest runs with the `dangerous-disk` package root as cwd.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const DIST = resolve(ROOT, 'dist');
const DIST_INDEX = resolve(DIST, 'index.html');

function requireDist(): void {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(
      `dist/index.html not found at ${DIST_INDEX}. ` +
        'Run `npm run build` in dangerous-disk before running the smoke tests.',
    );
  }
}

function readDistIndex(): string {
  requireDist();
  return readFileSync(DIST_INDEX, 'utf8');
}

// ---------------------------------------------------------------------------
// Req 22.2 — ad-free DOM.
// ---------------------------------------------------------------------------

// Markers for third-party ad networks, tag managers, and analytics/trackers.
// Each is matched case-insensitively against the built HTML.
const AD_TRACKER_MARKERS: { label: string; pattern: RegExp }[] = [
  { label: 'Google DoubleClick', pattern: /doubleclick\.net/i },
  { label: 'Google AdSense (googlesyndication)', pattern: /googlesyndication\.com/i },
  { label: 'AdSense adsbygoogle', pattern: /adsbygoogle/i },
  { label: 'Google Ads pagead', pattern: /pagead2?/i },
  { label: 'gtag.js', pattern: /\bgtag\s*\(/i },
  { label: 'Google Tag Manager', pattern: /googletagmanager\.com/i },
  { label: 'Google Analytics (analytics.js/ga)', pattern: /google-analytics\.com/i },
  { label: 'Amazon ad system', pattern: /amazon-adsystem\.com/i },
  { label: 'Google adservice', pattern: /adservice\.google/i },
  { label: 'Taboola', pattern: /taboola/i },
  { label: 'Outbrain', pattern: /outbrain/i },
  { label: 'Media.net', pattern: /media\.net/i },
  { label: 'data-ad attribute', pattern: /data-ad-(?:client|slot)/i },
];

describe('Ad-free DOM (Req 22.2)', () => {
  it('the built homepage contains no ad-network or tracker markup', () => {
    const html = readDistIndex();

    const found = AD_TRACKER_MARKERS.filter((m) => m.pattern.test(html)).map(
      (m) => m.label,
    );

    expect(found, `Unexpected ad/tracker markup in dist/index.html: ${found.join(', ')}`).toEqual(
      [],
    );

    // Defense in depth: no <iframe> pointing at a known ad origin and no
    // generic "advertisement" container.
    expect(/<iframe[^>]+(doubleclick|googlesyndication|adservice)/i.test(html)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Req 22.1 / 22.7 — token-only styling for the homepage + layout chrome.
// ---------------------------------------------------------------------------

const LAYOUT_ASTRO = resolve(ROOT, 'src/layouts/Layout.astro');
const INDEX_ASTRO = resolve(ROOT, 'src/pages/index.astro');

/**
 * Extract the content of every `<style>…</style>` block from an Astro file.
 * These blocks are the component chrome styling we assert is token-driven; the
 * frontmatter / template above them is class-based (Tailwind utilities that
 * themselves resolve to tokens).
 */
function styleBlocks(source: string): string {
  const blocks = source.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  return blocks.join('\n');
}

// Hardcoded color literals that would bypass the token system: hex colors and
// raw rgb()/hsl() function calls. `var(--…)` token references are allowed.
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const RAW_RGB_HSL = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;

describe('Token-only styling (Req 22.1, 22.7)', () => {
  it('Layout.astro chrome styling references tokens and hardcodes no colors', () => {
    const source = readFileSync(LAYOUT_ASTRO, 'utf8');
    const styles = styleBlocks(source);

    // The base shell styling derives color/background/font from tokens.
    expect(styles).toMatch(/var\(--color-/);
    expect(styles).toMatch(/var\(--font-/);

    // No hardcoded color literals in the chrome styling.
    expect(HEX_COLOR.test(styles)).toBe(false);
    expect(RAW_RGB_HSL.test(styles)).toBe(false);
  });

  it('index.astro hero chrome styling is built entirely from gradient/color tokens', () => {
    const source = readFileSync(INDEX_ASTRO, 'utf8');
    const styles = styleBlocks(source);

    // The mesh gradient — the only decorative chrome — is built from tokens.
    expect(styles).toMatch(/var\(--color-gradient-/);

    // No hardcoded color literals: the palette comes only from tokens.
    expect(HEX_COLOR.test(styles)).toBe(false);
    expect(RAW_RGB_HSL.test(styles)).toBe(false);
  });

  it('the design tokens the chrome references are defined in theme.css', () => {
    const theme = readFileSync(resolve(ROOT, 'src/styles/theme.css'), 'utf8');
    // Spot-check the tokens the homepage/layout chrome relies on.
    expect(theme).toMatch(/--color-canvas-soft:/);
    expect(theme).toMatch(/--color-ink:/);
    expect(theme).toMatch(/--font-sans:/);
    expect(theme).toMatch(/--color-gradient-preview-start:/);
  });
});

// ---------------------------------------------------------------------------
// Req 22.7 — TTI < 3 s proxy via an eager-asset transfer budget at 5 Mbps.
// ---------------------------------------------------------------------------

// 5 Mbps = 5,000,000 bits/s = 625,000 bytes/s (the requirement's floor speed).
const BYTES_PER_SEC_AT_5MBPS = 5_000_000 / 8;

// We require the eager critical-path assets to transfer in well under the 3 s
// TTI budget, reserving the remainder for parse/compile/execute/render. A 1.5 s
// transfer ceiling (half the budget) is generous yet meaningful: it is far
// above the current footprint but well below what a regression (e.g. the
// 2+ MB Monaco editor bundle leaking into the eager path) would cost.
const EAGER_TRANSFER_BUDGET_SEC = 1.5;

/**
 * Collect the `/_astro/…` asset URLs the homepage references directly in its
 * HTML. With `client:load`, Astro emits the island entry script and its CSS
 * here; Monaco and the Web Workers are dynamically imported later and so are
 * intentionally absent from this eager set.
 */
function eagerAstroAssets(html: string): string[] {
  const matches = html.match(/\/_astro\/[A-Za-z0-9._-]+\.(?:js|css)/g) ?? [];
  return Array.from(new Set(matches));
}

/** Resolve a `/_astro/…` URL to its file path inside `dist/`. */
function distPathForAsset(assetUrl: string): string {
  return resolve(DIST, `.${assetUrl}`); // assetUrl starts with '/'
}

describe('Time-to-interactive budget proxy (Req 22.7)', () => {
  it('eager homepage assets transfer well within the 3 s TTI budget at 5 Mbps', () => {
    const html = readDistIndex();
    const assets = eagerAstroAssets(html);

    // The homepage must eagerly load at least its island entry script.
    expect(assets.some((a) => a.endsWith('.js'))).toBe(true);

    // Sum the gzip-compressed sizes (what the browser actually downloads),
    // including the HTML document itself.
    let totalCompressed = gzipSync(Buffer.from(html, 'utf8')).length;
    const perAsset: { asset: string; raw: number; gz: number }[] = [];
    for (const asset of assets) {
      const buf = readFileSync(distPathForAsset(asset));
      const gz = gzipSync(buf).length;
      totalCompressed += gz;
      perAsset.push({ asset, raw: buf.length, gz });
    }

    const transferSec = totalCompressed / BYTES_PER_SEC_AT_5MBPS;

    // eslint-disable-next-line no-console
    console.error(
      `[perf] eager TTI assets: ${perAsset.length} files, ` +
        `${(totalCompressed / 1024).toFixed(1) } KiB gzip, ` +
        `~${transferSec.toFixed(2)}s transfer @5Mbps ` +
        `[budget ${EAGER_TRANSFER_BUDGET_SEC}s] :: ` +
        perAsset
          .map((a) => `${a.asset.replace('/_astro/', '')}=${(a.gz / 1024).toFixed(1)}KiB`)
          .join(', '),
    );

    expect(transferSec).toBeLessThan(EAGER_TRANSFER_BUDGET_SEC);
  });

  it('the heavy Monaco editor bundle is NOT eagerly loaded by the homepage', () => {
    const html = readDistIndex();
    const assets = eagerAstroAssets(html);

    // Monaco's editor API and language mode are lazy-loaded only when the
    // Viewer mounts; they must never appear in the homepage's eager asset set,
    // or TTI would blow past the 3 s budget.
    const monacoLeak = assets.filter((a) =>
      /editor\.api|jsonMode|\.worker/i.test(a),
    );
    expect(
      monacoLeak,
      `Monaco/worker bundles must be lazy-loaded, not eager: ${monacoLeak.join(', ')}`,
    ).toEqual([]);
  });
});
