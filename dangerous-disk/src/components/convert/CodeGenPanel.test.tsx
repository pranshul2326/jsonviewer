/** @jsxImportSource preact */
// Feature: json-viewer-free — CodeGenPanel unit tests (Task 16.2)
//
// Validates: Requirements 14.6, 14.7, 14.8, 14.9
//
// CodeGenPanel turns the shared JSON document into typed definitions in one of
// five target languages by dispatching to a worker. These tests inject a fake
// generator (the `generate` prop) so the panel's orchestration is exercised
// without a real `Worker`, and assert:
//
//   • Language selection dispatches the right { text, language } payload and
//     renders the generated code; switching language re-dispatches (Req 14.6).
//   • The copy control writes the complete code and shows a visible
//     confirmation (Req 14.6).
//   • A failed clipboard write shows an error indication and retains the
//     displayed generated code unchanged (Req 14.9).
//   • Invalid JSON renders the validation error state in place of code
//     (Req 14.7).
//   • Empty / whitespace-only input renders the validation error state and does
//     not invoke the generator (Req 14.8).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { setDocumentText } from '../../lib/stores/document';
import CodeGenPanel, {
  type CodeGenPayload,
  type CodeGenResult,
  type GenerateFn,
} from './CodeGenPanel';

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

/** Wait out the 250 ms debounce and let the generator promise settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await Promise.resolve();
  await Promise.resolve();
}

/** Let Preact flush a batched re-render after a state-changing event. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const output = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Generated"]');
const alertBox = () => container.querySelector('[role="alert"]');
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);

describe('CodeGenPanel language selection (Req 14.6)', () => {
  it('dispatches the default TypeScript payload and renders the generated code', async () => {
    setDocumentText('{"a":1}');
    const calls: CodeGenPayload[] = [];
    const generate: GenerateFn = (payload) => {
      calls.push(payload);
      return Promise.resolve<CodeGenResult>({
        ok: true,
        code: 'export interface Root {\n  a: number;\n}',
      });
    };

    render(<CodeGenPanel generate={generate} />, container);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ text: '{"a":1}', language: 'typescript' });
    expect(output()?.value).toContain('export interface Root');
  });

  it('re-dispatches with the selected language when the user switches', async () => {
    setDocumentText('{"a":1}');
    const calls: CodeGenPayload[] = [];
    const generate: GenerateFn = (payload) => {
      calls.push(payload);
      return Promise.resolve<CodeGenResult>({ ok: true, code: `// ${payload.language}` });
    };

    render(<CodeGenPanel generate={generate} />, container);
    await settle();

    button('Go')!.click();
    await settle();

    expect(calls.at(-1)).toEqual({ text: '{"a":1}', language: 'go' });
    expect(output()?.value).toBe('// go');
  });
});

describe('CodeGenPanel copy (Req 14.6 confirmation / Req 14.9 failure)', () => {
  it('copies the complete code and shows a visible confirmation', async () => {
    setDocumentText('{"a":1}');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const generate: GenerateFn = () =>
      Promise.resolve<CodeGenResult>({ ok: true, code: 'type Root = { a: number };' });

    render(<CodeGenPanel generate={generate} />, container);
    await settle();

    button('Copy')!.click();
    await tick();

    expect(writeText).toHaveBeenCalledWith('type Root = { a: number };');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Copied');
    // The displayed code is unchanged after a successful copy.
    expect(output()?.value).toBe('type Root = { a: number };');
  });

  it('shows an error indication and retains the code when the clipboard write fails', async () => {
    setDocumentText('{"a":1}');
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });

    const generate: GenerateFn = () =>
      Promise.resolve<CodeGenResult>({ ok: true, code: 'type Root = { a: number };' });

    render(<CodeGenPanel generate={generate} />, container);
    await settle();

    button('Copy')!.click();
    await tick();
    await Promise.resolve();

    // An error indication is shown and the displayed code is retained unchanged.
    expect(alertBox()?.textContent).toContain('Copy failed');
    expect(output()?.value).toBe('type Root = { a: number };');
  });
});

describe('CodeGenPanel invalid JSON shows the validation error state (Req 14.7)', () => {
  it('renders the error and shows no code output', async () => {
    setDocumentText('{not json');
    const generate: GenerateFn = () =>
      Promise.resolve<CodeGenResult>({
        ok: false,
        error: 'Invalid JSON: Unexpected token n in JSON at position 1',
      });

    render(<CodeGenPanel generate={generate} />, container);
    await settle();

    expect(alertBox()?.textContent).toContain('Invalid JSON');
    expect(output()).toBeNull();
  });
});

describe('CodeGenPanel empty input shows the validation error state (Req 14.8)', () => {
  it('does not invoke the generator and shows the error state', async () => {
    const generate = vi.fn<GenerateFn>(() =>
      Promise.resolve<CodeGenResult>({ ok: true, code: '' }),
    );

    render(<CodeGenPanel generate={generate} />, container);
    await settle();

    expect(generate).not.toHaveBeenCalled();
    expect(alertBox()?.textContent).toContain('empty input');
    expect(output()).toBeNull();
  });
});
