/** @jsxImportSource preact */
// Feature: json-viewer-free — Share-link UI unit tests (Task 18.4)
//
// Validates: Requirements 20.2, 20.3, 20.4, 20.7
//
// AppShell hosts the Share-Link manager (Req 20). These tests drive the share
// request and share-load paths through the real component — rendering AppShell
// into a jsdom container with preact `render`, the same way StatusBar / Grid /
// Convert panel tests do — and assert the user-visible feedback surfaced via the
// share `data-testid` hooks:
//
//   share-button          — the "Share link" control.
//   share-copied          — successful copy confirmation (Req 20.1).
//   share-invalid-error   — empty / invalid JSON cannot be shared (Req 20.2).
//   share-too-large-error — encoded payload exceeds 2,000,000 chars (Req 20.3).
//   share-copy-error      — clipboard write failed (Req 20.4).
//   share-manual-link     — the link shown for manual copy when copy fails.
//   share-decode-error    — a loaded hash could not be decoded (Req 20.7).
//
// The share request is driven by clicking share-button; the share *load* path is
// driven by setting window.location.hash before mounting AppShell. Clipboard
// success/failure is injected via AppShell's `writeClipboard` prop so neither
// path depends on the real (jsdom-absent) Clipboard API.
//
// AppShell now renders the real tool panels (Task 19.3). The default Viewer
// panel mounts EditorPane, which dynamically imports Monaco inside an effect;
// Monaco cannot run under jsdom, so EditorPane is stubbed here. These share
// tests only exercise the Viewer and Grid tools (Grid has no Monaco), so this
// single stub keeps them running cleanly without the editor.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';

// Stub EditorPane so the Monaco dynamic import never runs in jsdom. ViewerPanel
// imports it via '../app/EditorPane'; vitest intercepts by resolved module id,
// so mocking it once here (it resolves to the same file) covers that import.
vi.mock('./EditorPane', () => ({
  EditorPane: () => null,
  default: () => null,
}));

import {
  $activeTool,
  $document,
  setActiveTool,
  setDocumentText,
  type Tool,
} from '../../lib/stores/document';
import AppShell, { type WriteClipboard } from './AppShell';

let container: HTMLDivElement;

beforeEach(() => {
  // Reset shared state and the URL hash so each test starts from a clean shell.
  setDocumentText('');
  setActiveTool('viewer');
  resetHash();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  // Unmount so AppShell's store subscriptions and listeners are torn down.
  render(null, container);
  container.remove();
  setDocumentText('');
  setActiveTool('viewer');
  resetHash();
});

/** Clear the URL hash between tests. */
function resetHash(): void {
  window.location.hash = '';
}

/**
 * Wait for preact to flush effects and any pending state updates. preact
 * schedules effects (e.g. AppShell's mount effect) via `requestAnimationFrame`,
 * so we wait for a frame and then drain the macro/microtask queues (which also
 * settles a clipboard promise's `.catch`) before asserting.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Query a single element by its share `data-testid` hook. */
function byTestId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

/** Mount AppShell into the fresh container, then let mount effects settle. */
async function mount(writeClipboard?: WriteClipboard): Promise<void> {
  render(<AppShell writeClipboard={writeClipboard} />, container);
  await flush();
}

/** Click the Share control and let the resulting feedback settle. */
async function clickShare(): Promise<void> {
  const button = byTestId('share-button');
  if (!button) throw new Error('expected a share-button to be rendered');
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
}

// ---------------------------------------------------------------------------
// Req 20.2 — empty or invalid JSON cannot be shared
// ---------------------------------------------------------------------------

describe('Share request with empty / invalid JSON shows the invalid error (Req 20.2)', () => {
  it('rejects an empty editor: shows share-invalid-error and copies nothing', async () => {
    const writeClipboard = vi.fn<WriteClipboard>(() => Promise.resolve());
    setDocumentText('');
    await mount(writeClipboard);

    await clickShare();

    expect(byTestId('share-invalid-error')).not.toBeNull();
    // No link was generated, so the clipboard writer was never invoked, and no
    // success / manual-copy surfaces appear.
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(byTestId('share-copied')).toBeNull();
    expect(byTestId('share-manual-link')).toBeNull();
  });

  it('rejects syntactically invalid JSON: shows share-invalid-error and copies nothing', async () => {
    const writeClipboard = vi.fn<WriteClipboard>(() => Promise.resolve());
    setDocumentText('{ not valid json ');
    await mount(writeClipboard);

    await clickShare();

    expect(byTestId('share-invalid-error')).not.toBeNull();
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(byTestId('share-copied')).toBeNull();
  });

  it('does not show the invalid error before the user requests a share', async () => {
    setDocumentText('');
    await mount(vi.fn<WriteClipboard>(() => Promise.resolve()));

    // The control is present but quiet until a share is requested.
    expect(byTestId('share-button')).not.toBeNull();
    expect(byTestId('share-invalid-error')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Req 20.3 — an over-size payload cannot be shared
// ---------------------------------------------------------------------------

describe('Share request with an over-size payload shows the too-large error (Req 20.3)', () => {
  /**
   * Build a high-entropy string of `length` base64url characters. Such text is
   * effectively incompressible, so DEFLATE cannot shrink it meaningfully and the
   * base64url-encoded hash stays close to `length` characters — comfortably over
   * the 2,000,000-character share limit when `length` exceeds it.
   */
  function incompressible(length: number): string {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const chars = new Array<string>(length);
    for (let i = 0; i < length; i++) {
      chars[i] = alphabet[(Math.random() * 64) | 0];
    }
    return chars.join('');
  }

  it('rejects a payload whose encoded form exceeds 2,000,000 characters', async () => {
    const writeClipboard = vi.fn<WriteClipboard>(() => Promise.resolve());
    // A valid JSON string of ~3,000,000 incompressible characters. Its encoded
    // (DEFLATE + base64url) form stays well above the 2,000,000-char limit.
    setDocumentText(JSON.stringify(incompressible(3_000_000)));
    await mount(writeClipboard);

    await clickShare();

    expect(byTestId('share-too-large-error')).not.toBeNull();
    // Nothing was copied and no success surface appeared.
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(byTestId('share-copied')).toBeNull();
    expect(byTestId('share-invalid-error')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Req 20.4 — clipboard failure surfaces the link for manual copy
// ---------------------------------------------------------------------------

describe('Share request whose clipboard write fails shows the manual-copy fallback (Req 20.4)', () => {
  it('shows share-copy-error and a share-manual-link carrying the link value', async () => {
    const writeClipboard = vi.fn<WriteClipboard>(() =>
      Promise.reject(new Error('clipboard blocked')),
    );
    setDocumentText('{"a":1}');
    await mount(writeClipboard);

    await clickShare();

    // The copy was attempted exactly once with a non-empty link.
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    const attemptedLink = writeClipboard.mock.calls[0][0];
    expect(typeof attemptedLink).toBe('string');
    expect(attemptedLink.length).toBeGreaterThan(0);

    // The copy-failed feedback and the manual-copy input are both shown.
    expect(byTestId('share-copy-error')).not.toBeNull();
    const manual = byTestId('share-manual-link') as HTMLInputElement | null;
    expect(manual).not.toBeNull();

    // The manual link mirrors the link we tried (and failed) to copy, and is the
    // encoded share URL (carries the tool + payload fields).
    expect(manual!.value).toBe(attemptedLink);
    expect(manual!.value).toContain('#tool=');
    expect(manual!.value).toContain('&d=1.');

    // The success surface never appeared.
    expect(byTestId('share-copied')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Req 20.7 — an undecodable share payload loads empty + retains the prior tool
// ---------------------------------------------------------------------------

describe('Loading an undecodable share payload shows the decode error (Req 20.7)', () => {
  /**
   * Seed the URL hash with a share payload (`d=…`) that cannot be decoded into
   * valid JSON. `1.AAAA` carries the correct scheme version but a payload that
   * base64url-decodes to bytes that are not a valid DEFLATE stream, so the codec
   * fails. The `tool=` value is intentionally not one of the four real tools, so
   * the loader cannot adopt it and must retain whatever tool was already active.
   */
  function seedUndecodableHash(): void {
    window.location.hash = '#tool=bogus&d=1.AAAA';
  }

  it('loads an empty editor, shows share-decode-error, and retains the prior tool', async () => {
    // The user's previously active tool is the Grid, not the default Viewer.
    setActiveTool('grid');
    setDocumentText('{"keep":"me"}');
    seedUndecodableHash();

    await mount();

    // Decode failure is surfaced.
    expect(byTestId('share-decode-error')).not.toBeNull();
    // The editor was loaded empty (the prior document text was cleared).
    expect($document.get().text).toBe('');
    // The previously active tool is retained — the bogus hash tool is ignored.
    expect($activeTool.get()).toBe<Tool>('grid');
  });

  it('retains the default Viewer tool when no prior tool was chosen', async () => {
    // Active tool left at its default (Viewer).
    seedUndecodableHash();

    await mount();

    expect(byTestId('share-decode-error')).not.toBeNull();
    expect($document.get().text).toBe('');
    expect($activeTool.get()).toBe<Tool>('viewer');
  });

  it('does not show a decode error for a plain link with no share payload', async () => {
    // A `#tool=…` link with no `d=` payload is a normal navigation link, not a
    // share link, so no decode is attempted and no error is shown.
    window.location.hash = '#tool=grid';

    await mount();

    expect(byTestId('share-decode-error')).toBeNull();
    // The plain tool link is still adopted.
    expect($activeTool.get()).toBe<Tool>('grid');
  });
});
