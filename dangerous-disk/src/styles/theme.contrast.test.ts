// Feature: json-viewer-free, Property 35: Design token contrast meets WCAG AA
//
// Validates: Requirements 22.6
//
// "THE Application SHALL render all text and interactive controls at a contrast
//  ratio of at least 4.5:1 for normal text (below 18 point or below 14 point
//  bold) and at least 3:1 for large text (18 point and above, or 14 point bold
//  and above) and for the visual boundaries of interactive controls, in
//  conformance with WCAG 2.1 Level AA."
//
// Strategy
// --------
// The design tokens live in `src/styles/theme.css` as Tailwind 4 `@theme`
// custom properties. This test reads that file directly (so it tracks the real
// tokens and fails on drift) and exercises EVERY text-on-surface and
// interactive-boundary token pair that the UI actually composes. Each pair is
// classified per WCAG 2.1 SC 1.4.3 / 1.4.11:
//
//   - 'normal'   normal-size text                     -> requires >= 4.5:1
//   - 'large'    >= 18px (or >= 14px bold) text        -> requires >= 3:1
//   - 'boundary' visual boundary of an interactive ctl -> requires >= 3:1
//
// The pairs were derived from the component sources:
//   - app/NavigationBar.tsx, app/StatusBar.tsx, app/EditorPane.tsx
//   - viewer/TreePanel.tsx, viewer/TypeBadge.tsx, viewer/RichMedia.tsx
//
// Contrast ratios use the WCAG relative-luminance formula. Where a token is
// composited over a surface at fractional opacity (e.g. badge fills at /10 and
// rings at /30), we alpha-blend onto the surface first, exactly as the browser
// would, before computing luminance.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';

// ─── Token table, parsed from the real theme.css ─────────────────────────────
// Resolved from the package root (Vitest runs with cwd at dangerous-disk).

const THEME_CSS_PATH = resolve(process.cwd(), 'src/styles/theme.css');

/**
 * Extract the body of a single CSS block (`selector { … }`) from the stylesheet.
 * The theme blocks (`@theme` and `html.dark`) contain no nested braces, so the
 * first closing brace terminates the block.
 */
function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`block "${selector}" not found in theme.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) throw new Error(`malformed block "${selector}"`);
  return css.slice(open + 1, close);
}

/** Parse every `--color-*: #rrggbb;` declaration from a block of CSS. */
function parseColorTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const re = /--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    tokens[m[1]] = m[2].toLowerCase();
  }
  return tokens;
}

const THEME_CSS = readFileSync(THEME_CSS_PATH, 'utf8');

/** Light-mode tokens come from the `@theme` block. */
const LIGHT_TOKENS = parseColorTokens(extractBlock(THEME_CSS, '@theme'));

/**
 * Dark-mode tokens are the light tokens with the `html.dark` overrides applied
 * on top — exactly how the cascade resolves them at runtime, since dark mode
 * only redefines a subset of the `--color-*` variables.
 */
const DARK_TOKENS = {
  ...LIGHT_TOKENS,
  ...parseColorTokens(extractBlock(THEME_CSS, 'html.dark')),
};

// ─── Color math (WCAG 2.1) ───────────────────────────────────────────────────

interface RGB {
  r: number; // 0..255
  g: number;
  b: number;
}

/** Expand #rgb / #rgba / #rrggbb / #rrggbbaa into 8-bit channels (ignoring alpha). */
function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Alpha-blend `fg` (with alpha 0..1) over an opaque `bg`. */
function blend(fg: RGB, alpha: number, bg: RGB): RGB {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

/** sRGB 8-bit channel -> linear-light component. */
function linearize(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an opaque color. */
function relativeLuminance({ r, g, b }: RGB): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two opaque colors (>= 1). */
function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── The token pairs the UI composes ─────────────────────────────────────────

type Usage = 'normal' | 'large' | 'boundary';

interface Pair {
  /** Human-readable id used in failure messages. */
  id: string;
  /** Foreground token name (a `--color-*` key) or a literal #hex. */
  fg: string;
  /** Foreground alpha as composited by the UI (1 = opaque). */
  fgAlpha?: number;
  /** Surface (background) token name the foreground sits on. */
  surface: string;
  usage: Usage;
}

const SURFACES = ['canvas', 'canvas-soft', 'canvas-soft-2'] as const;

/**
 * Build the pair set for a given token table. Text tokens are checked against
 * every surface they can appear over; semantic accent text and badge labels
 * against their real backgrounds; control rings/borders as interactive
 * boundaries. The composited badge fills are written back into `tokens` under
 * synthetic `__badge-*-fill` keys so the pairs can reference them.
 */
function buildPairs(tokens: Record<string, string>): Pair[] {
  const pairs: Pair[] = [];

  // Primary body/heading/secondary/muted text on each app surface (normal text).
  for (const surface of SURFACES) {
    pairs.push({ id: `ink on ${surface}`, fg: 'ink', surface, usage: 'normal' });
    pairs.push({ id: `body on ${surface}`, fg: 'body', surface, usage: 'normal' });
    pairs.push({ id: `mute on ${surface}`, fg: 'mute', surface, usage: 'normal' });
  }

  // Button text on the primary (dark) CTA surface.
  pairs.push({ id: 'on-primary on primary', fg: 'on-primary', surface: 'primary', usage: 'normal' });

  // Semantic accent text used at caption / body-sm sizes (normal text).
  pairs.push({ id: 'link on canvas', fg: 'link', surface: 'canvas', usage: 'normal' });
  pairs.push({ id: 'link-deep on canvas', fg: 'link-deep', surface: 'canvas', usage: 'normal' });
  pairs.push({ id: 'success on canvas', fg: 'success', surface: 'canvas', usage: 'normal' });
  pairs.push({ id: 'error on canvas', fg: 'error', surface: 'canvas', usage: 'normal' });
  pairs.push({ id: 'error-deep on canvas', fg: 'error-deep', surface: 'canvas', usage: 'normal' });

  // Type-badge labels: `text-badge-X` over `bg-badge-X/10` over canvas (normal text).
  const badges = ['string', 'number', 'bool', 'null', 'array', 'object'] as const;
  for (const b of badges) {
    const surfaceHex = blend(hexToRgb(tokens[`badge-${b}`]), 0.1, hexToRgb(tokens.canvas));
    const surfaceLiteral = `#${[surfaceHex.r, surfaceHex.g, surfaceHex.b]
      .map((c) => Math.round(c).toString(16).padStart(2, '0'))
      .join('')}`;
    // Register the composited surface as a literal so the pair can reference it.
    tokens[`__badge-${b}-fill`] = surfaceLiteral;
    pairs.push({
      id: `badge-${b} label on badge-${b}/10 fill`,
      fg: `badge-${b}`,
      surface: `__badge-${b}-fill`,
      usage: 'normal',
    });
  }

  // Interactive control boundaries (button rings, input borders, dividers): >= 3:1.
  pairs.push({ id: 'hairline border on canvas', fg: 'hairline', surface: 'canvas', usage: 'boundary' });
  pairs.push({ id: 'hairline-strong border on canvas', fg: 'hairline-strong', surface: 'canvas', usage: 'boundary' });

  return pairs;
}

const LIGHT_PAIRS = buildPairs(LIGHT_TOKENS);
const DARK_PAIRS = buildPairs(DARK_TOKENS);

/** Minimum required ratio for a usage class. */
function threshold(usage: Usage): number {
  return usage === 'normal' ? 4.5 : 3;
}

/** Resolve a token name or literal hex to RGB, applying any fg alpha over the surface. */
function resolvePairColors(
  pair: Pair,
  tokens: Record<string, string>,
): { fg: RGB; bg: RGB; ratio: number } {
  const bgHex = tokens[pair.surface] ?? pair.surface;
  const bg = hexToRgb(bgHex);
  const fgHex = tokens[pair.fg] ?? pair.fg;
  let fg = hexToRgb(fgHex);
  if (pair.fgAlpha !== undefined && pair.fgAlpha < 1) {
    fg = blend(fg, pair.fgAlpha, bg);
  }
  return { fg, bg, ratio: contrastRatio(fg, bg) };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 35: Design token contrast meets WCAG AA (Req 22.6)', () => {
  it('parsed the expected color tokens from theme.css', () => {
    // Sanity guard so a broken parse cannot make the property vacuously pass.
    expect(LIGHT_TOKENS.canvas).toBe('#ffffff');
    expect(LIGHT_TOKENS.ink).toBe('#171717');
    expect(LIGHT_PAIRS.length).toBeGreaterThanOrEqual(20);
    // Dark mode redefines the surfaces and ink, so its tokens must differ.
    expect(DARK_TOKENS.canvas).toBe('#111111');
    expect(DARK_TOKENS.ink).toBe('#ededed');
  });

  // Property: for ALL text-on-surface / boundary token pairs the UI composes,
  // the computed contrast ratio meets its WCAG AA threshold — in light mode.
  test.prop([fc.constantFrom(...LIGHT_PAIRS)], { numRuns: 100 })(
    'every light-mode UI token pair meets its WCAG AA contrast threshold',
    (pair) => {
      const { ratio } = resolvePairColors(pair, LIGHT_TOKENS);
      const min = threshold(pair.usage);
      // Throwing with a descriptive message surfaces the offending pair in the
      // fast-check counterexample.
      if (ratio + 1e-9 < min) {
        throw new Error(
          `${pair.id}: contrast ${ratio.toFixed(3)}:1 < required ${min}:1 (${pair.usage})`,
        );
      }
      return true;
    },
  );

  // The same property must hold for the dark-mode palette (`html.dark` tokens).
  test.prop([fc.constantFrom(...DARK_PAIRS)], { numRuns: 100 })(
    'every dark-mode UI token pair meets its WCAG AA contrast threshold',
    (pair) => {
      const { ratio } = resolvePairColors(pair, DARK_TOKENS);
      const min = threshold(pair.usage);
      if (ratio + 1e-9 < min) {
        throw new Error(
          `${pair.id}: contrast ${ratio.toFixed(3)}:1 < required ${min}:1 (${pair.usage})`,
        );
      }
      return true;
    },
  );
});
