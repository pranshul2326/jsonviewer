/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 11.2
//
// AppShell — the single interactive island mounted by the homepage
// (`<AppShell client:load />`). It is the client-side tool router.
//
// What it does (mapped to requirements):
//   • Req 21.2 — swaps the four tool panels (Viewer, Diff, Grid, Converter)
//     in-memory. There is no full page navigation: only the active panel is
//     rendered and switching is a synchronous store update + re-render, so the
//     visible tool view changes well under 500 ms.
//   • Req 21.5/21.6 — the shared editor document lives in the `$document`
//     nanostore, which is never touched on a tool switch. Switching panels
//     therefore preserves the document byte-for-byte and never re-parses; tools
//     that read the shared document (Viewer/Grid/Converter) see the exact same
//     content when returning, and a tool that keeps its own buffers (Diff)
//     leaves `$document` untouched in memory.
//   • Linkable state — the active tool is mirrored into the URL hash
//     (`#tool=<tool>`) and read back on load / on `hashchange`, so navigation
//     is shareable and survives reload. Any other hash parameters (e.g. a
//     future `&d=` share payload, Req 20) are preserved when the tool is
//     rewritten.
//
// The public shape is kept stable for `index.astro`: a default export rendered
// with no required props. There is no advertising or third-party script here
// (Req 22.2); all chrome derives from design tokens (Req 22.1).

import { useStore } from '@nanostores/preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import {
  $activeTool,
  $document,
  setActiveTool,
  setDocumentText,
  type Tool,
} from '../../lib/stores/document';
import { decodeShare, encodeShare } from '../../lib/json-core/share';
import {
  dispatchShortcut,
  requestCollapseAll,
  type ShortcutContext,
} from '../../lib/keyboard/shortcuts';
import NavigationBar from './NavigationBar';
import ShortcutHelp from './ShortcutHelp';
import ViewerPanel from '../viewer/ViewerPanel';
import DiffTool from '../diff/DiffTool';
import GridPanel from '../grid/GridPanel';
import ConverterTool from '../convert/ConverterTool';

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/** The four tools in display order, the single source of truth for routing. */
const TOOLS: readonly Tool[] = ['viewer', 'diff', 'grid', 'converter'] as const;

/** Narrow an arbitrary string to a {@link Tool}. */
function isTool(value: string | null | undefined): value is Tool {
  return value != null && (TOOLS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// URL hash mirroring (`#tool=<tool>`)
// ---------------------------------------------------------------------------
//
// The hash is treated as a set of `&`-separated `key=value` pairs so the tool
// can be mirrored without clobbering other parameters (e.g. a share payload).

/** Read the active tool encoded in the current URL hash, if any. */
function readToolFromHash(): Tool | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const tool = params.get('tool');
  return isTool(tool) ? tool : null;
}

/**
 * Mirror the active tool into the URL hash, preserving any other hash
 * parameters. Uses `history.replaceState` so the sync neither scrolls the page
 * nor floods the back/forward history with intermediate entries.
 */
function writeToolToHash(tool: Tool): void {
  if (typeof window === 'undefined') return;
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  if (params.get('tool') === tool) return; // already in sync — nothing to do
  params.set('tool', tool);
  const nextHash = `#${params.toString()}`;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${nextHash}`);
}

// ---------------------------------------------------------------------------
// Share-Link manager (Req 20)
// ---------------------------------------------------------------------------
//
// The share manager turns the current document + active tool into a shareable
// URL (Req 20.1) and reverses that on load (Req 20.5). All state lives here in
// AppShell so the codec (`encodeShare`/`decodeShare`), the shared stores, and
// the URL hash stay in one place; `ShareControl` below is purely presentational.

/** The user-visible state of the share manager after a request or a load. */
type ShareFeedback =
  | null
  | { kind: 'copied' }
  | { kind: 'invalid' }
  | { kind: 'too-large' }
  | { kind: 'copy-failed'; link: string }
  | { kind: 'decode-failed' };

/** Human-readable share messages (kept here so the copy is testable). */
const SHARE_MESSAGES = {
  /** Req 20.1 — successful copy confirmation. */
  copied: 'Link copied to the clipboard.',
  /** Req 20.2 — empty or invalid JSON cannot be shared. */
  invalid: 'Enter valid JSON before sharing — a valid JSON payload is required.',
  /** Req 20.3 — encoded payload exceeds 2,000,000 characters. */
  tooLarge: 'This JSON is too large to share via a link.',
  /** Req 20.4 — clipboard write failed; the link is shown for manual copy. */
  copyFailed: 'Copying the link failed. Copy it manually below.',
  /** Req 20.7 — the loaded hash could not be decoded into valid JSON. */
  decodeFailed:
    'This shared link could not be decoded. Loaded an empty editor instead.',
} as const;

/** How a share link is written to the clipboard; injectable for testing. */
export type WriteClipboard = (text: string) => Promise<void>;

/** Default clipboard writer over the async Clipboard API. */
function defaultWriteClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('Clipboard API unavailable'));
}

/**
 * Assemble the absolute share link from an encoded hash (the `tool=…&d=…` body
 * produced by {@link encodeShare}, without a leading `#`) and mirror it into the
 * current URL so the address bar itself becomes shareable (Req 20.1). Returns
 * the full link string for copying.
 */
function commitShareHash(hash: string): string {
  if (typeof window === 'undefined') return `#${hash}`;
  const { origin, pathname, search } = window.location;
  const nextHash = `#${hash}`;
  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${search}${nextHash}`,
  );
  return `${origin}${pathname}${search}${nextHash}`;
}

/** Read the raw share payload (`d=…`) from the current hash, if present. */
function readSharePayload(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(raw).get('d');
}

/** Props for the presentational {@link ShareControl}. */
interface ShareControlProps {
  /** Invoked when the user requests a share link (Req 20.1). */
  onShare: () => void;
  /** Current feedback to surface, or `null` for none. */
  feedback: ShareFeedback;
}

/**
 * The Share control: a button to request a link plus a live region that surfaces
 * the success/error feedback. Purely presentational — all logic lives in
 * {@link AppShell}. Exposes `data-testid` hooks for the share UI tests.
 */
function ShareControl({ onShare, feedback }: ShareControlProps) {
  return (
    <div class="flex flex-wrap items-center gap-sm" data-share-control>
      <button
        type="button"
        data-testid="share-button"
        class="rounded-xs px-sm py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
        onClick={onShare}
      >
        Share link
      </button>

      {feedback?.kind === 'copied' ? (
        <span
          data-testid="share-copied"
          role="status"
          aria-live="polite"
          class="text-caption text-success"
        >
          {SHARE_MESSAGES.copied}
        </span>
      ) : null}

      {feedback?.kind === 'invalid' ? (
        <span
          data-testid="share-invalid-error"
          role="alert"
          class="text-caption text-error-deep"
        >
          {SHARE_MESSAGES.invalid}
        </span>
      ) : null}

      {feedback?.kind === 'too-large' ? (
        <span
          data-testid="share-too-large-error"
          role="alert"
          class="text-caption text-error-deep"
        >
          {SHARE_MESSAGES.tooLarge}
        </span>
      ) : null}

      {feedback?.kind === 'decode-failed' ? (
        <span
          data-testid="share-decode-error"
          role="alert"
          class="text-caption text-error-deep"
        >
          {SHARE_MESSAGES.decodeFailed}
        </span>
      ) : null}

      {feedback?.kind === 'copy-failed' ? (
        <span class="flex flex-wrap items-center gap-xs">
          <span
            data-testid="share-copy-error"
            role="alert"
            class="text-caption text-error-deep"
          >
            {SHARE_MESSAGES.copyFailed}
          </span>
          <input
            data-testid="share-manual-link"
            type="text"
            readOnly
            aria-label="Share link to copy manually"
            class="min-w-[16rem] flex-1 rounded-xs border border-divider bg-canvas-soft px-xs py-xxs font-mono text-caption text-body"
            value={feedback.link}
          />
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool panels
// ---------------------------------------------------------------------------
//
// Each tool maps to its real panel component (Task 19.3):
//   • viewer    → ViewerPanel (Monaco editor + collapsible tree + status bar).
//   • diff      → DiffTool (Monaco diff editor + semantic list + patch export +
//                 three-way merge).
//   • grid      → GridPanel (virtualized searchable/filterable/sortable table).
//   • converter → ConverterTool (format converters + code generation + query).
//
// The Monaco-based panels (Viewer's EditorPane, DiffTool's DiffPanel) import
// Monaco client-only inside effects guarded on `window`, so nothing Monaco runs
// during the static SSR build. AppShell itself is a `client:load` island, so
// the panels only ever hydrate in the browser.

/**
 * The panel registry: one component per tool. The shared `$document` store is
 * never touched on a switch, so the document is preserved byte-for-byte across
 * tool changes (Req 21.5/21.6) and only the active panel is rendered (Req 21.2).
 */
// Each entry is a zero-prop wrapper around the real panel. The router always
// invokes panels with no props, and wrapping guarantees assignability to a
// no-prop `ComponentType` even for panels whose props are entirely optional
// (ViewerPanel/GridPanel) — preact's weak-type check rejects assigning such
// components to `ComponentType<{}>` directly. The wrappers add no behaviour.
const PANELS: Record<Tool, ComponentType> = {
  viewer: () => <ViewerPanel />,
  diff: () => <DiffTool />,
  grid: () => <GridPanel />,
  converter: () => <ConverterTool />,
};

// ---------------------------------------------------------------------------
// Tool-switch focus (Req 19.5)
// ---------------------------------------------------------------------------

/**
 * Move keyboard focus to the navigation entry for `tool`, producing a visible
 * focus indicator (Req 19.5). The NavigationBar renders each entry as a button
 * tagged `data-tool="<tool>"`; at narrow widths several entries share the tag
 * (desktop row + mobile menu), so the first *visible* match is focused.
 */
function focusToolEntry(tool: Tool): void {
  if (typeof document === 'undefined') return;
  const candidates = document.querySelectorAll<HTMLElement>(
    `[data-tool="${tool}"]`,
  );
  for (const el of Array.from(candidates)) {
    // `offsetParent === null` for display:none elements (e.g. the hidden
    // desktop row below 960px), so this skips entries that cannot be focused.
    if (el.offsetParent !== null) {
      el.focus();
      return;
    }
  }
  // Fall back to the first candidate if none reports as visible (e.g. in a
  // headless test environment where layout is not computed).
  candidates[0]?.focus();
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

/**
 * The application shell and client-side tool router. Renders the navigation bar
 * and exactly one tool panel — the active one — swapping panels in-memory while
 * the shared `$document` store stays untouched across switches. It also hosts
 * the global keyboard manager (Req 19) and the shortcuts reference overlay.
 */
export interface AppShellProps {
  /**
   * How a share link is written to the clipboard (Req 20.1/20.4). Defaults to
   * the async Clipboard API; injectable so the share UI tests can drive both
   * the success and copy-failure paths deterministically.
   */
  writeClipboard?: WriteClipboard;
  /**
   * Whether the Share-link control is shown in the navigation bar. Defaults to
   * `true`. Temporarily set to `false` in production to hide the feature until
   * it is re-enabled (the share load/encode logic is left intact).
   */
  enableShare?: boolean;
}

export default function AppShell({
  writeClipboard = defaultWriteClipboard,
  enableShare = true,
}: AppShellProps = {}) {
  const activeTool = useStore($activeTool);
  const [helpOpen, setHelpOpen] = useState(false);
  // Share manager feedback (Req 20.1–20.4, 20.7). `null` = nothing to show.
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback>(null);

  // On mount: adopt any tool encoded in the URL hash, decode a share payload if
  // one is present, then keep the store in sync with subsequent hash changes
  // (back/forward, manual edits).
  useEffect(() => {
    const fromHash = readToolFromHash();
    if (fromHash && fromHash !== $activeTool.get()) {
      setActiveTool(fromHash);
    }

    // Share-link load (Req 20.5/20.7). Only attempt a decode when the hash
    // actually carries a share payload, so a plain `#tool=…` link is untouched.
    if (readSharePayload() !== null) {
      const decoded = decodeShare(window.location.hash);
      if (decoded.ok) {
        // Populate the editor and active tool from the decoded link (Req 20.5).
        setDocumentText(decoded.text);
        if (isTool(decoded.tool)) {
          setActiveTool(decoded.tool);
        }
      } else {
        // Undecodable hash: load an empty editor while retaining the prior /
        // default tool, and surface the decode error (Req 20.7).
        setDocumentText('');
        setShareFeedback({ kind: 'decode-failed' });
      }
    }

    const onHashChange = () => {
      const tool = readToolFromHash();
      if (tool && tool !== $activeTool.get()) {
        setActiveTool(tool);
      }
    };

    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Share request (Req 20.1–20.4): encode the current document + active tool,
  // mirror the link into the URL, and copy it to the clipboard.
  const onShare = useCallback(() => {
    const result = encodeShare($document.get().text, $activeTool.get());
    if (!result.ok) {
      // Empty/invalid JSON (Req 20.2) or an over-size payload (Req 20.3).
      setShareFeedback({
        kind: result.reason === 'too-large' ? 'too-large' : 'invalid',
      });
      return;
    }

    const link = commitShareHash(result.hash);
    writeClipboard(link)
      .then(() => setShareFeedback({ kind: 'copied' }))
      // Clipboard write failed: show the link for manual copy (Req 20.4).
      .catch(() => setShareFeedback({ kind: 'copy-failed', link }));
  }, [writeClipboard]);

  // Mirror the active tool into the URL hash whenever it changes (including the
  // initial value), preserving other hash parameters.
  useEffect(() => {
    writeToolToHash(activeTool);
  }, [activeTool]);

  // Global keyboard manager (Req 19.6): a single capture-phase listener on the
  // window responds to every defined shortcut regardless of which element holds
  // focus (the editor, a tree row, a nav button, etc.). When a shortcut matches
  // we stop the browser's default handling so the app action wins.
  useEffect(() => {
    const ctx: ShortcutContext = {
      collapseAll: requestCollapseAll, // Req 19.4
      switchTool: (tool) => {
        // Req 19.5 — activate the tool, then move a visible focus to its nav
        // entry. Focus is applied after the store update so the (possibly
        // re-rendered) entry exists in the DOM.
        setActiveTool(tool);
        requestAnimationFrame(() => focusToolEntry(tool));
      },
      openShortcutsHelp: () => setHelpOpen(true), // Req 19.7
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Let the dedicated overlay handler own Escape while it is open.
      const matched = dispatchShortcut(event, ctx);
      if (matched) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const ActivePanel = PANELS[activeTool];
  // The Viewer and Diff tools grow to their content (the page scrolls), so the
  // editor/tree/semantic-list/patch are all reachable rather than crammed into
  // one fixed card. The Grid and Converter keep a fixed, viewport-tall card so
  // their internal virtualization has a bounded scroll area.
  const fillTool = activeTool !== 'viewer' && activeTool !== 'diff';

  return (
    <section
      aria-label="Json Viewer Free workbench"
      class="flex min-h-0 flex-1 flex-col gap-sm"
    >
      <NavigationBar
        trailing={
          enableShare ? (
            <ShareControl onShare={onShare} feedback={shareFeedback} />
          ) : undefined
        }
      />

      {/* Only the active tool view is rendered, so it is the single visible
          tool view (Req 21.2/21.3). The shared $document is preserved across
          switches because swapping panels never mutates the store (Req 21.5/21.6).
          The wrapper grows to fill the remaining height so the active panel
          (editor/tree/grid) is tall rather than leaving empty space below. */}
      <div
        data-active-tool={activeTool}
        class={`mx-lg mb-md flex flex-col overflow-hidden rounded-md border border-hairline bg-canvas shadow-level-1 ${
          fillTool ? 'h-[calc(100dvh-6rem)] min-h-0' : ''
        }`}
      >
        <ActivePanel />
      </div>

      {/* Keyboard-shortcuts reference overlay (Req 19.7). */}
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </section>
  );
}
