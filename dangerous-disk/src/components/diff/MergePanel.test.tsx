/** @jsxImportSource preact */
// Feature: json-viewer-free — MergePanel conflict-count export gating tests (Task 14.5)
//
// Validates: Requirements 11.7
//
// Req 11.7 (Three-Way Merge): IF unresolved conflicts remain when a user
// requests the merged output, THEN the Application displays the count of
// unresolved conflicts and blocks export of the merged document.
// (Req 11.8 surface: when none remain, the merged document is produced for
// export.)
//
// MergePanel owns its Base/Left/Right textareas and drives the pure
// `threeWayMerge` / `resolveConflict` core. We render it into jsdom, type three
// documents that produce a single conflicting path, assert the unresolved-count
// message is shown and export is blocked, then resolve the conflict and assert
// export becomes available with the merged output rendered.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { MergePanel } from './MergePanel';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

/**
 * Let Preact flush the merge `useEffect` AND the re-render its `setMergeResult`
 * schedules. Effects run after commit (scheduled via rAF/timeout) and the state
 * update they trigger needs a further flush, so we wait a real interval and
 * then drain trailing microtasks — mirroring the ConvertPanel test's settle.
 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await Promise.resolve();
  await Promise.resolve();
}

/** Set a merge input's text and dispatch the input event the panel listens for. */
function typeInput(role: 'base' | 'left' | 'right', text: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    `#merge-input-${role}`,
  );
  if (!textarea) throw new Error(`missing ${role} input`);
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

const exportBlocked = () =>
  container.querySelector('[data-status="export-blocked"]');
const exportReady = () =>
  container.querySelector('[data-status="export-ready"]');
const mergedOutput = () =>
  container.querySelector<HTMLTextAreaElement>('[data-output="merged"]');

/**
 * Drive the panel to a single conflict at path `/a`:
 *   base a=1, left a=2, right a=3 → left ≠ right and both ≠ base ⇒ conflict.
 */
async function mountWithOneConflict(): Promise<void> {
  render(<MergePanel />, container);
  typeInput('base', '{"a":1}');
  typeInput('left', '{"a":2}');
  typeInput('right', '{"a":3}');
  await tick();
}

describe('MergePanel export gating with unresolved conflicts (Req 11.7)', () => {
  it('shows the unresolved-conflict count and blocks export while a conflict remains', async () => {
    await mountWithOneConflict();

    const blocked = exportBlocked();
    expect(blocked).not.toBeNull();
    // The count of unresolved conflicts is displayed.
    expect(blocked?.textContent).toContain('1');
    expect(blocked?.textContent?.toLowerCase()).toContain('unresolved');
    // Export is blocked: no merged output surface is rendered.
    expect(exportReady()).toBeNull();
    expect(mergedOutput()).toBeNull();

    // The conflict itself is presented with Base/Left/Right values (Req 11.5).
    const conflictRow = container.querySelector('[data-conflict-path="/a"]');
    expect(conflictRow).not.toBeNull();
  });

  it('unblocks export once every conflict is resolved (Req 11.8 surface)', async () => {
    await mountWithOneConflict();
    expect(exportBlocked()).not.toBeNull();

    // Resolve the conflict by choosing the Left value.
    const resolveLeft = container.querySelector<HTMLButtonElement>(
      '[data-conflict-path="/a"] [data-resolve="left"]',
    );
    expect(resolveLeft).not.toBeNull();
    resolveLeft!.click();
    await tick();

    // Export is no longer blocked; the merged document is produced for export.
    expect(exportBlocked()).toBeNull();
    expect(exportReady()).not.toBeNull();
    const output = mergedOutput();
    expect(output).not.toBeNull();
    // The chosen Left value (a=2) is reflected in the merged output.
    expect(JSON.parse(output!.value)).toEqual({ a: 2 });
  });

  it('shows the singular vs plural conflict count correctly', async () => {
    // Two independent conflicting paths produce a count of 2.
    render(<MergePanel />, container);
    typeInput('base', '{"a":1,"b":1}');
    typeInput('left', '{"a":2,"b":2}');
    typeInput('right', '{"a":3,"b":3}');
    await tick();

    const blocked = exportBlocked();
    expect(blocked).not.toBeNull();
    expect(blocked?.textContent).toContain('2');
    expect(blocked?.textContent?.toLowerCase()).toContain('conflicts');
  });
});

describe('MergePanel awaiting input (Req 11.7 precondition)', () => {
  it('blocks export and shows no count until all three documents are valid', async () => {
    render(<MergePanel />, container);
    typeInput('base', '{"a":1}');
    typeInput('left', '{"a":2}');
    // Right left empty: the merge cannot be computed yet.
    await tick();

    expect(exportReady()).toBeNull();
    expect(exportBlocked()).toBeNull();
    expect(
      container.querySelector('[data-status="awaiting-input"]'),
    ).not.toBeNull();
  });
});
