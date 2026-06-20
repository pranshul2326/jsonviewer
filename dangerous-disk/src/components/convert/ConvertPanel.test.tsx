/** @jsxImportSource preact */
// Feature: json-viewer-free — ConvertPanel unit tests (Task 16.1)
//
// Validates: Requirements 13.4, 13.9, 13.10
//
// ConvertPanel converts the JSON document to/from YAML/XML/CSV/TOML in both
// directions by dispatching to a worker. These tests inject a fake converter
// (the `convert` prop) so the panel's orchestration is exercised without a real
// `Worker`, and assert:
//
//   • Both directions dispatch the right { text, format, direction } payload and
//     render the converted output (Req 13.9 — wired through the worker seam).
//   • A failed conversion shows a descriptive, located error (line/path) and
//     leaves the source — including the shared document — unchanged (Req 13.4,
//     13.10).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { $document, setDocumentText } from '../../lib/stores/document';
import ConvertPanel, {
  type ConvertFn,
  type ConvertPayload,
  type ConvertResult,
} from './ConvertPanel';

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
});

/** Wait out the 250 ms debounce and let the converter promise settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Flush any trailing microtasks queued by the resolved promise.
  await Promise.resolve();
  await Promise.resolve();
}

/** Let Preact flush a batched re-render after a state-changing event. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const sourceTextarea = (label: string) =>
  container.querySelector<HTMLTextAreaElement>(`textarea[aria-label^="${label}"]`);
const output = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Output"]');
const alertBox = () => container.querySelector('[role="alert"]');

describe('ConvertPanel JSON → format (Req 13.9 via worker seam)', () => {
  it('dispatches the fromJson payload and renders the converted output', async () => {
    setDocumentText('{"a":1}');
    const calls: ConvertPayload[] = [];
    const convert: ConvertFn = (payload) => {
      calls.push(payload);
      return Promise.resolve<ConvertResult>({ ok: true, text: 'a: 1\n' });
    };

    render(<ConvertPanel convert={convert} />, container);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ text: '{"a":1}', format: 'yaml', direction: 'fromJson' });
    expect(output()?.value).toBe('a: 1\n');
  });
});

describe('ConvertPanel format → JSON', () => {
  it('converts user-supplied source and offers to load the result into the editor', async () => {
    const calls: ConvertPayload[] = [];
    const convert: ConvertFn = (payload) => {
      calls.push(payload);
      return Promise.resolve<ConvertResult>({ ok: true, text: '{\n  "a": 1\n}' });
    };

    render(<ConvertPanel convert={convert} />, container);

    // Switch to the "YAML → JSON" direction via the swap control.
    const toJsonButton = container.querySelector<HTMLButtonElement>(
      'button[data-action="swap-direction"]',
    )!;
    toJsonButton.click();
    await tick();

    // Type YAML into the source textarea.
    const src = sourceTextarea('Source YAML')!;
    src.value = 'a: 1';
    src.dispatchEvent(new Event('input', { bubbles: true }));

    await settle();

    expect(calls.at(-1)).toEqual({ text: 'a: 1', format: 'yaml', direction: 'toJson' });
    expect(output()?.value).toBe('{\n  "a": 1\n}');

    // The "Load into editor" control writes the result into the shared document.
    const load = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Load into editor',
    )!;
    expect(load).toBeTruthy();
    load.click();
    expect($document.get().text).toBe('{\n  "a": 1\n}');
  });
});

describe('ConvertPanel failure leaves the source unchanged (Req 13.4, 13.10)', () => {
  it('shows a descriptive, located error and does not mutate the shared document', async () => {
    setDocumentText('{"a":1}');
    const convert: ConvertFn = () =>
      Promise.resolve<ConvertResult>({
        ok: false,
        error: {
          message: 'CSV conversion requires the top-level value to be an array of objects.',
          path: '$',
        },
      });

    render(<ConvertPanel convert={convert} />, container);

    // Select CSV (the format that rejects a non-array-of-objects root).
    const csvButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'CSV',
    )!;
    csvButton.click();
    await settle();

    const box = alertBox();
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain('array of objects');
    expect(box?.textContent).toContain('Path $');
    expect(box?.textContent).toContain('source is unchanged');

    // No output is shown, and the shared document text is untouched.
    expect(output()).toBeNull();
    expect($document.get().text).toBe('{"a":1}');
  });

  it('renders the 1-based line when the error carries one', async () => {
    const convert: ConvertFn = () =>
      Promise.resolve<ConvertResult>({
        ok: false,
        error: { message: 'Input is not valid YAML.', line: 3 },
      });

    render(<ConvertPanel convert={convert} />, container);

    const toJsonButton = container.querySelector<HTMLButtonElement>(
      'button[data-action="swap-direction"]',
    )!;
    toJsonButton.click();
    await tick();

    const src = sourceTextarea('Source YAML')!;
    src.value = 'a: : :';
    src.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    expect(alertBox()?.textContent).toContain('Line 3');
  });
});

describe('ConvertPanel empty source', () => {
  it('does not invoke the converter when the source is empty', async () => {
    const convert = vi.fn<ConvertFn>(() =>
      Promise.resolve<ConvertResult>({ ok: true, text: '' }),
    );

    render(<ConvertPanel convert={convert} />, container);
    await settle();

    expect(convert).not.toHaveBeenCalled();
  });
});
