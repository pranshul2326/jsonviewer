/** @jsxImportSource preact */
// Feature: json-viewer-free — TypeBadge property + unit tests (Task 13.4)
//
// TypeBadge (task 13.3) renders exactly one token-colored, distinctly-labeled
// badge per JSON value type for the six supported types, plus an unknown ("?")
// fallback badge for anything else. These tests cover:
//
//   Property 6: Exactly one type badge matches each node's type
//               — Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
//   Property 7: Type badges are mutually distinct
//               — Validates: Requirements 3.7
//   Unit:       Unknown/unsupported type renders a single fallback badge
//               — Validates: Requirements 3.8
//
// The component is purely presentational, so we render it into a jsdom
// container with preact's `render` (the same approach as StatusBar.test.tsx,
// since @testing-library/preact is not part of the dependency set).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { render } from 'preact';
import type { JsonType } from '../../lib/json-core/types';
import { TypeBadge } from './TypeBadge';

// Runs per property, aligned with the rest of the suite.
const NUM_RUNS = 100;

// The six supported JSON value types.
const JSON_TYPES: readonly JsonType[] = [
  'string',
  'number',
  'boolean',
  'null',
  'array',
  'object',
];

// Expected label per type, mirroring the component's distinct-label contract
// (Req 3.1–3.6). Each type must render a badge carrying exactly this label.
const EXPECTED_LABEL: Record<JsonType, string> = {
  string: 'str',
  number: 'num',
  boolean: 'bool',
  null: 'null',
  array: '[]',
  object: '{}',
};

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  // Unmount and detach between cases so no state leaks across renders.
  render(null, container);
  container.remove();
});

/** Render a single TypeBadge for `type` into the shared container. */
function mount(type: string): void {
  render(<TypeBadge type={type} />, container);
}

/** Every badge the component emits carries a `data-type` attribute. */
function badges(): Element[] {
  return Array.from(container.querySelectorAll('[data-type]'));
}

/**
 * Extract the color-bearing class token from a badge's class list. The
 * component drives every badge color from a `text-badge-*` (supported types)
 * or `text-mute` (unknown) utility; that token is the visual color identity.
 * Note: the shared base classes include the unrelated `text-caption` font-size
 * utility, so we match the color token specifically rather than any `text-*`.
 */
function colorToken(el: Element): string {
  const classes = (el.getAttribute('class') ?? '').split(/\s+/);
  const token = classes.find((c) => c.startsWith('text-badge-') || c === 'text-mute');
  if (!token) throw new Error(`badge has no text-color token: ${el.getAttribute('class')}`);
  return token;
}

describe('Property 6: exactly one type badge matches each node type (Req 3.1–3.6)', () => {
  // Feature: json-viewer-free, Property 6: Exactly one type badge matches each
  // node's type. For any of the six JSON types, TypeBadge renders exactly one
  // badge whose label corresponds to that type.
  test.prop([fc.constantFrom(...JSON_TYPES)], { numRuns: NUM_RUNS })(
    'renders exactly one badge with the label for the given type',
    (type) => {
      // Fresh container per generated case (the per-test container is reused
      // across fast-check runs, so clear it before each render).
      render(null, container);
      mount(type);

      const rendered = badges();
      // Exactly one badge is emitted (Req 3.1–3.6: "exactly one type badge").
      expect(rendered).toHaveLength(1);

      const badge = rendered[0];
      // Its label corresponds to the node's JSON type.
      expect(badge.textContent).toBe(EXPECTED_LABEL[type]);
      // And it is tagged with the type it represents.
      expect(badge.getAttribute('data-type')).toBe(type);
    },
  );
});

describe('Property 7: type badges are mutually distinct (Req 3.7)', () => {
  // Feature: json-viewer-free, Property 7: Type badges are mutually distinct.
  // The type->label and type->color mappings are each injective across the six
  // supported types, so no two badges are visually identical. We assert this by
  // rendering all six and confirming their labels and color tokens are unique.
  test.prop([fc.constant(null)], { numRuns: NUM_RUNS })(
    'label and color mappings are each injective across the six types',
    () => {
      const labels: string[] = [];
      const colors: string[] = [];

      for (const type of JSON_TYPES) {
        render(null, container);
        mount(type);
        const rendered = badges();
        expect(rendered).toHaveLength(1);
        labels.push(rendered[0].textContent ?? '');
        colors.push(colorToken(rendered[0]));
      }

      // Injective label mapping: six types -> six distinct labels.
      expect(new Set(labels).size).toBe(JSON_TYPES.length);
      // Injective color mapping: six types -> six distinct color tokens.
      expect(new Set(colors).size).toBe(JSON_TYPES.length);
    },
  );

  it('every supported type uses a distinct badge-color token', () => {
    // A concrete companion to the property: the supported-type colors are all
    // `text-badge-*` tokens and all different from one another.
    const colors = JSON_TYPES.map((type) => {
      render(null, container);
      mount(type);
      return colorToken(badges()[0]);
    });

    for (const token of colors) {
      expect(token.startsWith('text-badge-')).toBe(true);
    }
    expect(new Set(colors).size).toBe(JSON_TYPES.length);
  });
});

describe('Unknown-type fallback badge (Req 3.8)', () => {
  it('renders a single "?" badge for an unsupported type without error', () => {
    expect(() => mount('weird-unsupported-type')).not.toThrow();

    const rendered = badges();
    // A single fallback badge is rendered (the node is not omitted).
    expect(rendered).toHaveLength(1);
    // Labeled to indicate an unknown type.
    expect(rendered[0].textContent).toBe('?');
  });

  it('renders the "?" fallback for an empty type string without error', () => {
    expect(() => mount('')).not.toThrow();

    const rendered = badges();
    expect(rendered).toHaveLength(1);
    expect(rendered[0].textContent).toBe('?');
  });

  it('gives the unknown badge a label distinct from all six supported labels', () => {
    mount('definitely-not-a-json-type');
    const unknownLabel = badges()[0].textContent ?? '';

    const supportedLabels = JSON_TYPES.map((t) => EXPECTED_LABEL[t]);
    expect(supportedLabels).not.toContain(unknownLabel);
    expect(unknownLabel).toBe('?');
  });
});
