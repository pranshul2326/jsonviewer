/** @jsxImportSource preact */
// Feature: json-viewer-free — ViewerPanel unit tests (Task 13.9)
//
// Validates: Requirements 1.4, 1.5, 1.7
//
// ViewerPanel assembles EditorPane + TreePanel + StatusBar and owns the
// collapse-all / expand-all controls plus the validation error state. These
// tests stub EditorPane (so Monaco never loads under jsdom) and exercise
// ViewerPanel's own orchestration against the shared `$document` store:
//
//   • Invalid JSON renders the validation error state (error description +
//     1-based line:column) in place of the tree (Req 1.7).
//   • Valid JSON renders the tree (no error state) and enables the collapse-all
//     / expand-all controls (Req 1.4, 1.5).
//   • Empty / whitespace-only input is valid (not an error) and shows the
//     empty-document hint with the controls disabled (Req 1.7 boundary).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';

// Stub EditorPane so the Monaco dynamic import never runs in jsdom.
vi.mock('../app/EditorPane', () => ({
  EditorPane: () => null,
  default: () => null,
}));

import { setDocumentText } from '../../lib/stores/document';
import ViewerPanel from './ViewerPanel';

let container: HTMLDivElement;

beforeEach(() => {
  setDocumentText('');
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  setDocumentText('');
  vi.restoreAllMocks();
});

const errorRegion = () => container.querySelector('[data-region="viewer-error"]');
const emptyRegion = () => container.querySelector('[data-region="viewer-empty"]');
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
const expandToggle = () =>
  container.querySelector('[data-testid="expand-toggle"]') as HTMLButtonElement | null;

/**
 * Wait for Preact to flush effects and any resulting re-render. Preact schedules
 * `useEffect` (here TreePanel's expansion-status report) via
 * `requestAnimationFrame`, so we wait a frame then drain the task queues before
 * asserting on the single Expand/Collapse toggle's label.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ViewerPanel validation error state (Req 1.7)', () => {
  it('renders the error description with 1-based line:column instead of the tree', () => {
    setDocumentText('{ "a": }');
    render(<ViewerPanel />, container);

    const region = errorRegion();
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('alert');
    // The error description carries a 1-based line and column (Req 6.4).
    expect(region!.textContent).toMatch(/Line \d+, column \d+/);
    // No empty-document hint while invalid.
    expect(emptyRegion()).toBeNull();
  });

  it('disables the collapse-all / expand-all controls when there is no tree', () => {
    setDocumentText('{ not json');
    render(<ViewerPanel />, container);

    // A single Expand/Collapse toggle now replaces the old pair. With no tree it
    // is present (labelled "Expand all") but disabled, and there is no separate
    // "Collapse all" button.
    expect(expandToggle()?.disabled).toBe(true);
    expect(expandToggle()?.textContent?.trim()).toBe('Expand all');
    expect(button('Collapse all')).toBeUndefined();
  });
});

describe('ViewerPanel valid document (Req 1.4, 1.5)', () => {
  it('renders the tree and drives a single Expand/Collapse toggle', async () => {
    setDocumentText('{ "a": 1, "b": [2, 3] }');
    render(<ViewerPanel />, container);
    await flush();

    // No validation error / empty state for a valid, non-empty document.
    expect(errorRegion()).toBeNull();
    expect(emptyRegion()).toBeNull();

    // A single toggle replaces the old expand-all / collapse-all pair. A
    // multi-node document starts with only the root expanded, so the toggle
    // offers "Expand all" (Req 1.5) and is enabled.
    expect(expandToggle()).not.toBeNull();
    expect(expandToggle()!.disabled).toBe(false);
    expect(expandToggle()!.textContent?.trim()).toBe('Expand all');

    // Clicking expands every node, so the toggle flips to "Collapse all"
    // (Req 1.4).
    expandToggle()!.click();
    await flush();
    expect(expandToggle()!.textContent?.trim()).toBe('Collapse all');

    // Clicking again collapses back to only the root, returning the toggle to
    // "Expand all".
    expandToggle()!.click();
    await flush();
    expect(expandToggle()!.textContent?.trim()).toBe('Expand all');
  });
});

describe('ViewerPanel empty document (valid-empty boundary)', () => {
  it('shows the empty-document hint, not the error state', () => {
    setDocumentText('   ');
    render(<ViewerPanel />, container);

    expect(errorRegion()).toBeNull();
    expect(emptyRegion()).not.toBeNull();
    expect(button('Expand all')?.disabled).toBe(true);
  });
});
