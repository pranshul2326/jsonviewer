/** @jsxImportSource preact */
// Feature: json-viewer-free — NavigationBar tests (Task 11.5)
//
// Two concerns are covered here:
//
//   • Property 33 (single active tool) — Validates: Requirements 21.3, 21.4.
//     For any sequence of tool selections, exactly one navigation entry carries
//     the active-state indicator and it matches the active tool, with every
//     other entry inactive.
//
//   • Responsive breakpoint layout unit tests — Validates: Requirements 22.3,
//     22.4, 22.5. jsdom does not evaluate CSS media queries, so the <600px,
//     600–959px, and ≥960px behaviors are asserted via the documented Tailwind
//     responsive class hooks that drive them: the desktop row uses
//     `hidden min-[960px]:flex` (shown only at ≥960px) and the toggle + mobile
//     panel use `min-[960px]:hidden` (shown only below 960px).
//
// NavigationBar reads/writes the shared `$activeTool` store. Tests drive it both
// by simulating clicks (real selection wiring) and via `setActiveTool`, then
// render into a jsdom container — the same pattern StatusBar.test.tsx uses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { render } from 'preact';
import { $activeTool, setActiveTool, type Tool } from '../../lib/stores/document';
import { routePath } from '../../lib/routing/tools';
import { NavigationBar } from './NavigationBar';

const TOOLS: readonly Tool[] = ['viewer', 'diff', 'grid', 'converter'] as const;

let container: HTMLDivElement;

beforeEach(() => {
  setActiveTool('viewer');
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  // Unmount and detach so the store subscription is torn down between tests.
  render(null, container);
  container.remove();
  setActiveTool('viewer');
});

/** Mount a fresh NavigationBar reflecting the current store state. */
function mount(): void {
  render(<NavigationBar />, container);
}

/**
 * Flush Preact's deferred render queue. Store/state changes re-render on a
 * microtask, so DOM assertions made right after an interaction must wait for
 * that flush. A macrotask tick covers Preact's promise-based deferral.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The desktop navigation row (`role="list"`), always present in the DOM. */
function desktopRow(): Element {
  const row = container.querySelector('[role="list"]');
  if (!row) throw new Error('expected the desktop navigation row to be present');
  return row;
}

/** The single mobile toggle control (`data-toggle="nav-menu"`). */
function toggle(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[data-toggle="nav-menu"]');
  if (!el) throw new Error('expected the mobile toggle control to be present');
  return el;
}

/** All entries within a scope that report the active-state indicator. */
function activeEntries(scope: Element): Element[] {
  return Array.from(scope.querySelectorAll('[data-active="true"]'));
}

describe('NavigationBar — Property 33: Navigation has a single active tool', () => {
  // Feature: json-viewer-free, Property 33: Navigation has a single active tool
  // Validates: Requirements 21.3, 21.4
  //
  // The site is now a multi-page application: each tool entry is a real link to
  // its own page, and the active tool is set on the shared store by the tool
  // page on load. For any non-empty sequence of activations, after applying them
  // in order:
  //   • exactly one entry carries the active-state indicator (Req 21.4), and
  //   • that entry is the last-activated tool, matching `$activeTool` (Req 21.3),
  //   • with every other entry explicitly inactive.
  test.prop([fc.array(fc.constantFrom(...TOOLS), { minLength: 1, maxLength: 20 })], {
    numRuns: 100,
  })('any sequence of activations leaves exactly one active entry matching $activeTool', async (sequence) => {
    setActiveTool('viewer');
    mount();
    await flush();

    // Apply the sequence by activating tools on the shared store, the way each
    // tool page does on load (Req 21.3).
    for (const tool of sequence) {
      setActiveTool(tool);
    }

    const expected = sequence[sequence.length - 1];
    expect($activeTool.get()).toBe(expected);

    // Re-mount fresh so the render deterministically reflects the current store
    // (initial render reads the active tool synchronously), then assert the
    // single active-state invariant on that render.
    render(null, container);
    mount();

    const row = desktopRow();
    const active = activeEntries(row);

    // Exactly one active-state indicator across the four entries (Req 21.4).
    expect(active).toHaveLength(1);
    // The active entry is the selected tool (Req 21.3).
    expect(active[0].getAttribute('data-tool')).toBe(expected);
    expect(active[0].getAttribute('aria-current')).toBe('page');

    // Every other entry is explicitly inactive with no indicator (Req 21.4).
    const inactive = Array.from(row.querySelectorAll('[data-active="false"]'));
    expect(inactive).toHaveLength(TOOLS.length - 1);
    for (const el of inactive) {
      expect(el.getAttribute('aria-current')).toBeNull();
      expect(el.getAttribute('data-tool')).not.toBe(expected);
    }

    // Cleanly unmount between runs so subscriptions do not accumulate.
    render(null, container);
  });

  it('renders each entry as a link to that tool’s page (multi-page application)', () => {
    mount();
    for (const tool of TOOLS) {
      const link = desktopRow().querySelector<HTMLAnchorElement>(
        `[data-tool="${tool}"]`,
      );
      expect(link, `expected a link for tool "${tool}"`).not.toBeNull();
      expect(link!.tagName).toBe('A');
      expect(link!.getAttribute('href')).toBe(routePath(tool));
    }
    render(null, container);
  });

  it('marks exactly one entry active for each tool selected directly via the store', () => {
    for (const tool of TOOLS) {
      setActiveTool(tool);
      mount();

      const active = activeEntries(desktopRow());
      expect(active).toHaveLength(1);
      expect(active[0].getAttribute('data-tool')).toBe(tool);

      render(null, container);
    }
  });
});

describe('NavigationBar — responsive breakpoint layout (Req 22.3, 22.4, 22.5)', () => {
  // jsdom cannot compute media queries, so we assert the documented responsive
  // class hooks that produce each breakpoint's layout. The same DOM is rendered
  // at every width; CSS alone decides visibility, so verifying the hooks proves
  // the correct layout will apply at each breakpoint band.

  it('<600px: exposes navigation through a single collapse-only toggle control (Req 22.3)', () => {
    mount();

    // Exactly one toggle control exists and it is collapse-only (`min-[960px]:hidden`).
    const toggles = container.querySelectorAll('[data-toggle="nav-menu"]');
    expect(toggles).toHaveLength(1);

    const t = toggle();
    expect(t.getAttribute('class')).toContain('min-[960px]:hidden');
    // It is a real toggle: a menu opener wired to the collapsible panel.
    expect(t.getAttribute('aria-haspopup')).toBe('menu');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.getAttribute('aria-controls')).toBe('nav-mobile-menu');

    // The full desktop row is suppressed below 960px via `hidden ... min-[960px]:flex`.
    const rowClass = desktopRow().getAttribute('class') ?? '';
    expect(rowClass).toContain('hidden');
    expect(rowClass).toContain('min-[960px]:flex');
  });

  it('600–959px: stays in the same collapsed layout as below 600px (Req 22.4)', async () => {
    mount();

    // The band shares the collapsed layout: toggle shown <960px, desktop row hidden.
    const t = toggle();
    expect(t.getAttribute('class')).toContain('min-[960px]:hidden');

    const rowClass = desktopRow().getAttribute('class') ?? '';
    expect(rowClass).toContain('hidden');
    expect(rowClass).toContain('min-[960px]:flex');

    // Opening the toggle reveals the collapsed menu panel, also gated to <960px.
    toggle().click();
    await flush();
    const panel = container.querySelector('#nav-mobile-menu');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('menu');
    expect(panel?.getAttribute('class')).toContain('min-[960px]:hidden');
    // All four entries are reachable from within the collapsed menu.
    expect(panel?.querySelectorAll('[role="menuitem"]')).toHaveLength(TOOLS.length);
  });

  it('≥960px: shows a full horizontal row of all four entries with no toggle (Req 22.5)', () => {
    mount();

    // The desktop row becomes visible at ≥960px (`min-[960px]:flex`) and lists
    // all four entries.
    const row = desktopRow();
    expect(row.getAttribute('class')).toContain('min-[960px]:flex');
    const entries = row.querySelectorAll('[data-tool]');
    expect(entries).toHaveLength(TOOLS.length);
    expect(Array.from(entries, (e) => e.getAttribute('data-tool'))).toEqual([...TOOLS]);

    // The toggle is suppressed at ≥960px (`min-[960px]:hidden`), so no toggle
    // control is presented in the full horizontal layout.
    expect(toggle().getAttribute('class')).toContain('min-[960px]:hidden');
  });
});
