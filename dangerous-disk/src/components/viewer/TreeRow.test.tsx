/** @jsxImportSource preact */
// Feature: json-viewer-free — TreeRow path-copy clipboard unit tests (Task 13.6)
//
// Validates: Requirements 4.3, 4.4
//
// TreeRow copies a node's JSON_Path to the clipboard via an injectable
// `writeClipboard` prop. These tests cover the two clipboard behaviours the
// task calls out:
//
//   Req 4.3: on a successful clipboard write the confirmation indicator appears
//            within 500 ms and stays visible for at least 2 seconds before it
//            is dismissed.
//   Req 4.4: when the clipboard write fails, a copy-error indication is shown
//            and the displayed document is left unchanged (no edit committed).
//
// The 2-second hold is asserted with fake timers: the confirmation is still
// present 1 ms before the COPY_INDICATOR_MS deadline and gone shortly after.
// The clipboard write resolves/rejects on the microtask queue (not a timer),
// so we flush microtasks between interactions to let Preact re-render. This
// follows the jsdom + `preact` `render` pattern used by RichMedia.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';

import { TreeRow, COPY_INDICATOR_MS } from './TreeRow';
import type { FlatRow, RowHandlers } from './TreePanel';
import { parseJson } from '../../lib/json-core/parse';
import type { JsonNode } from '../../lib/json-core/types';

let container: HTMLDivElement;

/** A two-member object document used as the fixture for every test. */
function fixtureModel(): JsonNode {
  const result = parseJson('{"alpha":1,"beta":"two"}');
  if (!result.ok || result.empty) throw new Error('fixture failed to parse');
  return result.model;
}

/** The `beta` member node — a string scalar whose dot-path is `beta`. */
function betaNode(root: JsonNode): JsonNode {
  const node = root.children?.find((c) => c.key === 'beta');
  if (!node) throw new Error('fixture missing the beta member');
  return node;
}

/** A FlatRow for a (non-root) scalar member. */
function scalarRow(node: JsonNode): FlatRow {
  return { node, depth: 1, expanded: false, hasChildren: false };
}

const handlers: RowHandlers = { toggle: () => {} };

/** Flush the microtask queue so Preact applies any queued re-render. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** Locate the dot-notation path-copy button rendered for the row. */
function copyButton(): HTMLButtonElement {
  const btn = container.querySelector('button[aria-label="Copy dot-notation path"]');
  if (!btn) throw new Error('dot-notation copy button not found');
  return btn as HTMLButtonElement;
}

const confirmation = () => container.querySelector('[data-testid="copy-confirmation"]');
const copyError = () => container.querySelector('[data-testid="copy-error"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  vi.useRealTimers();
});

describe('TreeRow path-copy confirmation timing (Req 4.3)', () => {
  it('shows the confirmation promptly and holds it for at least 2 seconds', async () => {
    vi.useFakeTimers();

    const root = fixtureModel();
    const writes: string[] = [];
    const writeClipboard = (text: string): Promise<void> => {
      writes.push(text);
      return Promise.resolve();
    };
    const onCommit = vi.fn();

    render(
      <TreeRow
        row={scalarRow(betaNode(root))}
        handlers={handlers}
        root={root}
        onCommit={onCommit}
        writeClipboard={writeClipboard}
      />,
      container,
    );

    // No confirmation before the user copies.
    expect(confirmation()).toBeNull();

    copyButton().click();
    // The clipboard write resolves on the microtask queue, then Preact
    // re-renders — no real time passes, so this is well within the 500 ms
    // budget.
    await flushMicrotasks();

    expect(writes).toEqual(['beta']);
    expect(confirmation()).not.toBeNull();

    // Still held one millisecond before the 2-second deadline.
    await vi.advanceTimersByTimeAsync(COPY_INDICATOR_MS - 1);
    await flushMicrotasks();
    expect(confirmation()).not.toBeNull();

    // Dismissed once the >= 2-second hold elapses.
    await vi.advanceTimersByTimeAsync(2);
    await flushMicrotasks();
    expect(confirmation()).toBeNull();

    // Copying never mutates the document.
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('TreeRow path-copy failure handling (Req 4.4)', () => {
  it('shows a copy-error indication and leaves the document unchanged when the write fails', async () => {
    vi.useFakeTimers();

    const root = fixtureModel();
    const writeClipboard = (): Promise<void> =>
      Promise.reject(new Error('clipboard access denied'));
    const onCommit = vi.fn();

    render(
      <TreeRow
        row={scalarRow(betaNode(root))}
        handlers={handlers}
        root={root}
        onCommit={onCommit}
        writeClipboard={writeClipboard}
      />,
      container,
    );

    const textBefore = container.textContent;

    copyButton().click();
    await flushMicrotasks();

    // The failure is surfaced as a copy-error, never as a success confirmation.
    expect(copyError()).not.toBeNull();
    expect(confirmation()).toBeNull();

    // The displayed document is unchanged: no edit was committed and the row's
    // key/value still render.
    expect(onCommit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('beta');
    expect(container.textContent).toContain('two');
    expect(textBefore).toContain('beta');
  });
});
