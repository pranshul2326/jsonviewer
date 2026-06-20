/** @jsxImportSource preact */
// Feature: json-viewer-free — PatchExport copy confirmation/failure tests (Task 14.5)
//
// Validates: Requirements 10.5, 10.6
//
// Req 10.5: when the user copies the JSON_Patch and the clipboard write
//   completes, the Application displays a confirmation indication within 1 s.
// Req 10.6: if the clipboard write fails or access is denied, the Application
//   displays an error indication identifying that the copy did not complete,
//   AND retains the displayed JSON_Patch unchanged.
//
// PatchExport accepts an injectable `writeClipboard` so both the success and
// failure paths are driven deterministically, and exposes data-testid hooks
// (patch-copy-confirmation / patch-copy-error / patch-text). We render it into
// jsdom, click the copy control, and assert the indicator and the retained
// patch text.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { PatchExport } from './PatchExport';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

/** Flush the microtasks queued by the resolved/rejected clipboard promise. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const copyButton = () =>
  container.querySelector<HTMLButtonElement>('[data-action="copy-patch"]');
const confirmation = () =>
  container.querySelector('[data-testid="patch-copy-confirmation"]');
const copyError = () =>
  container.querySelector('[data-testid="patch-copy-error"]');
const patchText = () =>
  container.querySelector<HTMLTextAreaElement>('[data-testid="patch-text"]');

// Two documents that differ, so a non-empty patch is computed.
const LEFT = '{"a":1}';
const RIGHT = '{"a":2}';

describe('PatchExport copy confirmation (Req 10.5)', () => {
  it('shows the confirmation indication after a successful clipboard write', async () => {
    const writeClipboard = vi.fn(() => Promise.resolve());
    render(
      <PatchExport left={LEFT} right={RIGHT} writeClipboard={writeClipboard} />,
      container,
    );

    // No confirmation before copying.
    expect(confirmation()).toBeNull();

    copyButton()!.click();
    await flush();

    // The complete patch text was written to the clipboard.
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard.mock.calls[0][0]).toBe(patchText()!.value);

    // Confirmation indication is shown; no error indication.
    expect(confirmation()).not.toBeNull();
    expect(copyError()).toBeNull();
  });
});

describe('PatchExport copy failure retains the patch (Req 10.6)', () => {
  it('shows an error indication and leaves the displayed patch unchanged', async () => {
    const writeClipboard = vi.fn(() =>
      Promise.reject(new Error('clipboard access denied')),
    );
    render(
      <PatchExport left={LEFT} right={RIGHT} writeClipboard={writeClipboard} />,
      container,
    );

    const before = patchText()!.value;
    expect(before.length).toBeGreaterThan(0);

    copyButton()!.click();
    await flush();

    // Error indication shown; no confirmation.
    expect(copyError()).not.toBeNull();
    expect(confirmation()).toBeNull();

    // The displayed patch is retained unchanged.
    expect(patchText()!.value).toBe(before);
  });

  it('recovers to a confirmation on a subsequent successful copy', async () => {
    let shouldFail = true;
    const writeClipboard = vi.fn(() =>
      shouldFail
        ? Promise.reject(new Error('denied'))
        : Promise.resolve(),
    );
    render(
      <PatchExport left={LEFT} right={RIGHT} writeClipboard={writeClipboard} />,
      container,
    );

    copyButton()!.click();
    await flush();
    expect(copyError()).not.toBeNull();

    // A later successful attempt replaces the error with a confirmation.
    shouldFail = false;
    copyButton()!.click();
    await flush();

    expect(confirmation()).not.toBeNull();
    expect(copyError()).toBeNull();
  });
});
