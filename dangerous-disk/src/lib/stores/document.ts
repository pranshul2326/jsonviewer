// Feature: json-viewer-free
//
// Shared application state, framework-agnostic (Req 21.5, 21.6).
//
// These nanostores are the single source of truth shared across the four tool
// panels. The `@nanostores/preact` bindings are used inside components; this
// module stays free of any UI framework so the same stores can be read from
// workers, tests, or plain modules.
//
//   $document   — the one shared editor document (raw text + parsed model).
//                 Per Req 21.5/21.6 the document text must be preserved
//                 byte-for-byte across tool switches, so this store is the
//                 single source of truth shared by the Viewer/Grid/Converter
//                 tools.
//   $activeTool — which of the four navigation tools is currently active.
//   $settings   — UI/user settings (indentation style, rich-media on/off).

import { atom, map } from 'nanostores';
import { parseJson, type ParseResult } from '../json-core/parse';
import type { IndentStyle } from '../json-core/serialize';

// ---------------------------------------------------------------------------
// $document — shared editor document (text + parsed model)
// ---------------------------------------------------------------------------

/**
 * The shared editor document: the raw text exactly as the user entered it
 * (preserved byte-for-byte, Req 21.5/21.6) together with the result of parsing
 * that text into the in-memory model.
 */
export interface DocumentState {
  /** Raw editor text, stored verbatim. */
  text: string;
  /** Result of parsing {@link text}: a model, the valid-empty state, or an error. */
  parsed: ParseResult;
}

/** The empty document: empty text parses to the valid-empty state. */
const EMPTY_DOCUMENT: DocumentState = {
  text: '',
  parsed: parseJson(''),
};

/**
 * The single shared editor document. Holds the raw text and the parsed model
 * (and its validity). All tools read and write this one store, so the document
 * survives tool switches without re-parsing (Req 21.5, 21.6).
 */
export const $document = atom<DocumentState>(EMPTY_DOCUMENT);

/**
 * Set the editor text and recompute the parsed model. The text is stored
 * verbatim (byte-for-byte) and {@link parseJson} derives the model/validity.
 *
 * This parses synchronously on the main thread, so it is the path used for
 * small documents (< 5 MB). Large_Documents are parsed off the main thread and
 * the result is published via {@link setDocumentState} instead (Req 17.1).
 */
export function setDocumentText(text: string): void {
  $document.set({ text, parsed: parseJson(text) });
}

// ---------------------------------------------------------------------------
// Shared-document persistence (MPA navigation)
// ---------------------------------------------------------------------------
//
// The site is a multi-page application: each tool (Viewer, Diff, Grid,
// Converter) lives at its own URL, so switching tools is a real page
// navigation. To keep the document the user is working on as they move between
// tool pages, the shared editor text is mirrored into `sessionStorage`.
//
// `sessionStorage` (not `localStorage`) is deliberate: the document is scoped
// to the current browser tab and is cleared when the tab closes, which is the
// more privacy-preserving choice for potentially sensitive payloads. Access is
// guarded for SSR, wrapped so a blocked/full store never breaks the app, and
// size-limited to stay clear of the storage quota. The data never leaves the
// browser, so the no-network privacy guarantee (Req 18) is preserved.

const DOCUMENT_KEY = 'jvf:document';
const DOCUMENT_PERSIST_MAX = 2_000_000; // ~2 MB; skip persisting beyond this

/**
 * Restore the shared document from sessionStorage (client-only).
 *
 * This is intentionally NOT run at module-import time: doing so would populate
 * the store before the island hydrates, while the server-rendered HTML was
 * built with an empty document — a hydration mismatch that left the virtualized
 * tree mounted against stale DOM and measuring a zero-height viewport (the tree
 * stayed blank until a remount). Instead AppShell calls this from a mount
 * effect, so the document is restored *after* hydration and the tree mounts
 * cleanly with a settled layout.
 */
export function restoreDocumentFromSession(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const saved = sessionStorage.getItem(DOCUMENT_KEY);
    if (saved && saved !== $document.get().text) setDocumentText(saved);
  } catch {
    /* ignore corrupt or blocked storage */
  }
}

$document.listen((value) => {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (value.text.length === 0) {
      sessionStorage.removeItem(DOCUMENT_KEY);
      return;
    }
    if (value.text.length > DOCUMENT_PERSIST_MAX) {
      sessionStorage.removeItem(DOCUMENT_KEY);
      return;
    }
    sessionStorage.setItem(DOCUMENT_KEY, value.text);
  } catch {
    /* ignore quota errors or blocked storage */
  }
});

/**
 * Publish a document whose text was already parsed elsewhere (e.g. in a Web
 * Worker for a Large_Document, Req 17.1/17.4). The text is stored verbatim and
 * the provided {@link ParseResult} is used as-is, so no second parse runs on the
 * main thread.
 */
export function setDocumentState(text: string, parsed: ParseResult): void {
  $document.set({ text, parsed });
}

// ---------------------------------------------------------------------------
// $workerProgress — long-running worker activity (Req 17.3, 17.5)
// ---------------------------------------------------------------------------

/**
 * The state of an in-flight (or just-failed) long-running worker operation,
 * surfaced to the StatusBar so the user sees a progress indicator while a
 * Large_Document is processed (Req 17.3) and a reason when an operation fails
 * (Req 17.5).
 *
 *   - `{ status: 'running', label, progress }` — the operation is in flight;
 *     `progress` is a completion fraction in [0, 1], updated ≥1/sec.
 *   - `{ status: 'error', label, message }` — the operation failed; `message`
 *     is the human-readable reason. The prior view is retained by the tool; this
 *     only carries the reason to display.
 */
export type WorkerActivity =
  | { status: 'running'; label: string; progress: number }
  | { status: 'error'; label: string; message: string };

/**
 * Shared long-running worker activity. `null` when no operation is in flight
 * and none has recently failed. Tools set it while dispatching to a worker and
 * clear it on completion; the StatusBar renders whatever it holds (Req 17.3).
 */
export const $workerProgress = atom<WorkerActivity | null>(null);

/** Set (or clear, with `null`) the shared worker activity. */
export function setWorkerActivity(activity: WorkerActivity | null): void {
  $workerProgress.set(activity);
}

// ---------------------------------------------------------------------------
// $diffBuffers — Diff Checker comparisons (persisted across tool switches)
// ---------------------------------------------------------------------------
/**
 * A single Diff Checker comparison: one Left/Right document pair plus its
 * optional banner labels. Several comparisons are held at once and surfaced as
 * tabs in the Diff toolbar, so a user can keep multiple independent Left/Right
 * pairs open and switch between them without losing any (Req 21.5/21.6).
 */
export interface DiffComparison {
  /** Stable id — used as the tab key and active-tab reference. */
  id: string;
  /** Tab label shown in the tab bar (e.g. "Comparison 1"). */
  name: string;
  /** Left (original) document text. */
  left: string;
  /** Right (modified) document text. */
  right: string;
  /** Optional user label for the Left document (shown in the banner). */
  leftName: string;
  /** Optional user label for the Right document (shown in the banner). */
  rightName: string;
}
/**
 * The Diff Checker's comparisons and active mode. The Diff tool unmounts when
 * the user switches tools, so keeping these in a shared store (rather than
 * component state) preserves every open comparison when the user navigates away
 * and back (Req 21.5/21.6). The shared `$document` is never mutated by the Diff
 * tool; the first comparison's `left` is merely seeded from it on first entry.
 */
export interface DiffBuffers {
  /** All open comparisons (tabs); always at least one. */
  comparisons: DiffComparison[];
  /** Id of the active comparison. */
  activeId: string;
  /** Active mode: side-by-side compare, or three-way merge. */
  mode: 'compare' | 'merge';
  /** Whether the first comparison's Left has been seeded from the shared document yet. */
  seeded: boolean;
}
// A monotonic sequence plus randomness makes each new comparison id unique
// within the page, so a freshly-added tab never collides with a restored one.
// Kept at module scope (not exported): ids are minted only via the action
// helpers below.
let comparisonIdSeq = 0;
function nextComparisonId(prefix: string): string {
  comparisonIdSeq += 1;
  return `${prefix}-cmp-${comparisonIdSeq}-${Math.random().toString(36).slice(2, 8)}`;
}
// Derive the next "Comparison N" label: one past the highest existing N (so
// re-adding after closing middle tabs never reuses a visible number) and at
// least one past the current count.
function nextComparisonName(comparisons: readonly { name: string }[]): string {
  let max = 0;
  for (const c of comparisons) {
    const m = /^Comparison (\d+)$/.exec(c.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Comparison ${Math.max(max, comparisons.length) + 1}`;
}
// The first comparison uses a fixed id so the SSR and client module-load
// default values match; a random id would differ between the two renders and
// trip a hydration mismatch.
const FIRST_DIFF_COMPARISON_ID = 'diff-cmp-1';
/** The Diff Checker comparisons, retained for the lifetime of the session. */
export const $diffBuffers = map<DiffBuffers>({
  comparisons: [
    { id: FIRST_DIFF_COMPARISON_ID, name: 'Comparison 1', left: '', right: '', leftName: '', rightName: '' },
  ],
  activeId: FIRST_DIFF_COMPARISON_ID,
  mode: 'compare',
  seeded: false,
});
// Persist the Diff comparisons to localStorage so every open pair survives a
// page refresh. This is client-only and the data never leaves the browser, so
// the privacy guarantee (no network egress) is preserved. All access is guarded
// for SSR and wrapped so a blocked/full storage never breaks the app. Very
// large buffers are not persisted, to stay clear of the storage quota.
const DIFF_BUFFERS_KEY = 'jvf:diff-buffers';
const DIFF_PERSIST_MAX = 2_000_000; // ~2 MB combined; skip persisting beyond this
/** Guards the diff-buffer restore so it runs at most once per page load. */
let diffBuffersRestored = false;
/**
 * Coerce an unknown persisted value into a valid {@link DiffBuffers}, or return
 * `null` when it cannot be salvaged. Both shapes are accepted so a refresh keeps
 * working across the upgrade: the new multi-comparison shape (`{comparisons,
 * activeId, mode}`) and the legacy single-comparison shape (`{left, right,
 * leftName, rightName, mode}`) written by the previous version.
 */
function normalizeDiffBuffers(saved: unknown): DiffBuffers | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Record<string, unknown>;
  // New shape.
  if (Array.isArray(s.comparisons) && s.comparisons.length > 0) {
    const comparisons: DiffComparison[] = (s.comparisons as unknown[])
      .filter((c): c is Record<string, unknown> =>
        !!c && typeof c === 'object' &&
        typeof (c as Record<string, unknown>).left === 'string' &&
        typeof (c as Record<string, unknown>).right === 'string')
      .map((c, i) => ({
        id: typeof c.id === 'string' && c.id ? (c.id as string) : `diff-cmp-restored-${i + 1}`,
        name: typeof c.name === 'string' && c.name ? (c.name as string) : `Comparison ${i + 1}`,
        left: c.left as string,
        right: c.right as string,
        leftName: typeof c.leftName === 'string' ? (c.leftName as string) : '',
        rightName: typeof c.rightName === 'string' ? (c.rightName as string) : '',
      }));
    if (comparisons.length === 0) return null;
    const activeId = comparisons.some((c) => c.id === s.activeId) ? (s.activeId as string) : comparisons[0].id;
    return { comparisons, activeId, mode: s.mode === 'merge' ? 'merge' : 'compare', seeded: true };
  }
  // Legacy single-comparison shape.
  if (typeof s.left === 'string' && typeof s.right === 'string') {
    const first: DiffComparison = {
      id: FIRST_DIFF_COMPARISON_ID,
      name: 'Comparison 1',
      left: s.left as string,
      right: s.right as string,
      leftName: typeof s.leftName === 'string' ? (s.leftName as string) : '',
      rightName: typeof s.rightName === 'string' ? (s.rightName as string) : '',
    };
    return { comparisons: [first], activeId: first.id, mode: s.mode === 'merge' ? 'merge' : 'compare', seeded: true };
  }
  return null;
}
/**
 * Restore the Diff buffers from localStorage (client-only).
 *
 * Like {@link restoreDocumentFromSession}, this is intentionally NOT run at
 * module-import time. The Diff tool's mode (`compare` vs `merge`) is restored
 * here, and doing it at import would mutate `$diffBuffers` before the AppShell
 * island hydrates — while the server-rendered HTML was built with the default
 * `compare` mode. A saved `merge` mode would then hydrate the Merge DOM against
 * Compare markup, a hydration mismatch that left the Merge panel visibly
 * distorted until a re-render (e.g. toggling to Compare and back) reconciled it.
 * AppShell/DiffTool calls this from a mount effect instead, so the restore
 * happens *after* hydration and the panel renders cleanly on first load.
 */
export function restoreDiffBuffersFromStorage(): void {
  if (diffBuffersRestored) return;
  if (typeof localStorage === 'undefined') return;
  diffBuffersRestored = true;
  try {
    const raw = localStorage.getItem(DIFF_BUFFERS_KEY);
    if (!raw) return;
    const restored = normalizeDiffBuffers(JSON.parse(raw));
    if (restored) $diffBuffers.set(restored);
  } catch {
    /* ignore corrupt or blocked storage */
  }
}
$diffBuffers.listen((value) => {
  if (typeof localStorage === 'undefined') return;
  try {
    const total = value.comparisons.reduce((n, c) => n + c.left.length + c.right.length, 0);
    if (total > DIFF_PERSIST_MAX) {
      localStorage.removeItem(DIFF_BUFFERS_KEY);
      return;
    }
    localStorage.setItem(DIFF_BUFFERS_KEY, JSON.stringify(value));
  } catch {
    /* ignore quota errors or blocked storage */
  }
});
// ── Diff comparison actions — the ONLY way the UI mutates $diffBuffers ────────
/** Set the active Diff mode (side-by-side compare vs three-way merge). */
export function setDiffMode(mode: 'compare' | 'merge'): void {
  $diffBuffers.setKey('mode', mode);
}
/** Open a new, empty comparison and make it the active tab. */
export function addDiffComparison(): void {
  const state = $diffBuffers.get();
  const comparison: DiffComparison = {
    id: nextComparisonId('diff'),
    name: nextComparisonName(state.comparisons),
    left: '', right: '', leftName: '', rightName: '',
  };
  $diffBuffers.set({ ...state, comparisons: [...state.comparisons, comparison], activeId: comparison.id });
}
/**
 * Close the comparison with `id`. The last remaining comparison is never removed
 * (there is always at least one tab). When the active tab is closed, the
 * neighbour that slides into its slot becomes active.
 */
export function closeDiffComparison(id: string): void {
  const state = $diffBuffers.get();
  if (state.comparisons.length <= 1) return; // never remove the last tab
  const index = state.comparisons.findIndex((c) => c.id === id);
  if (index === -1) return;
  const comparisons = state.comparisons.filter((c) => c.id !== id);
  let activeId = state.activeId;
  if (activeId === id) activeId = comparisons[Math.min(index, comparisons.length - 1)].id;
  $diffBuffers.set({ ...state, comparisons, activeId });
}
/** Make the comparison with `id` the active tab (a no-op if already active or unknown). */
export function setActiveDiffComparison(id: string): void {
  const state = $diffBuffers.get();
  if (state.activeId === id) return;
  if (!state.comparisons.some((c) => c.id === id)) return;
  $diffBuffers.setKey('activeId', id);
}
/** Patch the active comparison's documents and/or labels in place. */
export function updateActiveDiffComparison(
  patch: Partial<Pick<DiffComparison, 'left' | 'right' | 'leftName' | 'rightName'>>,
): void {
  const state = $diffBuffers.get();
  const comparisons = state.comparisons.map((c) => (c.id === state.activeId ? { ...c, ...patch } : c));
  $diffBuffers.setKey('comparisons', comparisons);
}
/** Clear the active comparison's documents and labels (keeps the tab open). */
export function clearActiveDiffComparison(): void {
  updateActiveDiffComparison({ left: '', right: '', leftName: '', rightName: '' });
}
/**
 * Seed the first comparison's Left from the shared document the first time the
 * Diff tool is opened this session, so the content the user was viewing flows
 * into the comparison (Req 21.5/21.6). A no-op once seeded (including when
 * buffers were restored from storage, which sets `seeded`).
 */
export function seedDiffLeftIfNeeded(text: string): void {
  const state = $diffBuffers.get();
  if (state.seeded) return;
  const comparisons = state.comparisons.map((c, i) => (i === 0 ? { ...c, left: text } : c));
  $diffBuffers.set({ ...state, comparisons, seeded: true });
}

// ---------------------------------------------------------------------------
// $textCompareBuffers — Text Compare Left/Right buffers (persisted)
// ---------------------------------------------------------------------------

/**
 * A single Text Compare comparison: one Left/Right text pair plus its optional
 * banner labels. Several comparisons are held at once and surfaced as tabs in
 * the Text Compare toolbar, so a user can keep multiple independent Left/Right
 * pairs open and switch between them without losing any (Req 21.5/21.6). Mirrors
 * {@link DiffComparison} but for arbitrary plain text: there is no mode (compare
 * is the only mode) and the contents are never parsed or validated.
 */
export interface TextComparison {
  /** Stable id — used as the tab key and active-tab reference. */
  id: string;
  /** Tab label shown in the tab bar (e.g. "Comparison 1"). */
  name: string;
  /** Left (original) text. */
  left: string;
  /** Right (modified) text. */
  right: string;
  /** Optional user label for the Left text (shown in the banner). */
  leftName: string;
  /** Optional user label for the Right text (shown in the banner). */
  rightName: string;
}

/**
 * The Text Compare tool's comparisons. The tool unmounts when the user switches
 * tools, so keeping these in a shared store (rather than component state)
 * preserves every open comparison when the user navigates away and back (Req
 * 21.5/21.6). The shared `$document` is never mutated by the Text Compare tool;
 * the first comparison's `left` is merely seeded from it on first entry.
 */
export interface TextCompareBuffers {
  /** All open comparisons (tabs); always at least one. */
  comparisons: TextComparison[];
  /** Id of the active comparison. */
  activeId: string;
  /** Whether the first comparison's Left has been seeded from the shared document yet. */
  seeded: boolean;
}

// The first comparison uses a fixed id so the SSR and client module-load default
// values match; a random id would differ between the two renders and trip a
// hydration mismatch.
const FIRST_TEXT_COMPARISON_ID = 'text-cmp-1';

/** The Text Compare comparisons, retained for the lifetime of the session. */
export const $textCompareBuffers = map<TextCompareBuffers>({
  comparisons: [
    { id: FIRST_TEXT_COMPARISON_ID, name: 'Comparison 1', left: '', right: '', leftName: '', rightName: '' },
  ],
  activeId: FIRST_TEXT_COMPARISON_ID,
  seeded: false,
});

// Persist the Text Compare comparisons to localStorage so every open pair
// survives a page refresh. Client-only and never leaves the browser (privacy
// preserved), guarded for SSR, and wrapped so blocked/full storage never breaks
// the app. Very large buffers are not persisted, to stay clear of the quota.
const TEXT_COMPARE_BUFFERS_KEY = 'jvf:text-compare-buffers';
const TEXT_COMPARE_PERSIST_MAX = 2_000_000; // ~2 MB combined; skip beyond this

/** Guards the text-compare restore so it runs at most once per page load. */
let textCompareBuffersRestored = false;

/**
 * Coerce an unknown persisted value into a valid {@link TextCompareBuffers}, or
 * return `null` when it cannot be salvaged. Both shapes are accepted so a refresh
 * keeps working across the upgrade: the new multi-comparison shape
 * (`{comparisons, activeId}`) and the legacy single-comparison shape
 * (`{left, right, leftName, rightName}`) written by the previous version. There
 * is no `mode` field for Text Compare.
 */
function normalizeTextCompareBuffers(saved: unknown): TextCompareBuffers | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Record<string, unknown>;
  // New shape.
  if (Array.isArray(s.comparisons) && s.comparisons.length > 0) {
    const comparisons: TextComparison[] = (s.comparisons as unknown[])
      .filter((c): c is Record<string, unknown> =>
        !!c && typeof c === 'object' &&
        typeof (c as Record<string, unknown>).left === 'string' &&
        typeof (c as Record<string, unknown>).right === 'string')
      .map((c, i) => ({
        id: typeof c.id === 'string' && c.id ? (c.id as string) : `text-cmp-restored-${i + 1}`,
        name: typeof c.name === 'string' && c.name ? (c.name as string) : `Comparison ${i + 1}`,
        left: c.left as string,
        right: c.right as string,
        leftName: typeof c.leftName === 'string' ? (c.leftName as string) : '',
        rightName: typeof c.rightName === 'string' ? (c.rightName as string) : '',
      }));
    if (comparisons.length === 0) return null;
    const activeId = comparisons.some((c) => c.id === s.activeId) ? (s.activeId as string) : comparisons[0].id;
    return { comparisons, activeId, seeded: true };
  }
  // Legacy single-comparison shape.
  if (typeof s.left === 'string' && typeof s.right === 'string') {
    const first: TextComparison = {
      id: FIRST_TEXT_COMPARISON_ID,
      name: 'Comparison 1',
      left: s.left as string,
      right: s.right as string,
      leftName: typeof s.leftName === 'string' ? (s.leftName as string) : '',
      rightName: typeof s.rightName === 'string' ? (s.rightName as string) : '',
    };
    return { comparisons: [first], activeId: first.id, seeded: true };
  }
  return null;
}

/**
 * Restore the Text Compare buffers from localStorage (client-only). Called from
 * a mount effect (not at import time) so it runs after hydration, matching the
 * Diff buffers restore discipline.
 */
export function restoreTextCompareBuffersFromStorage(): void {
  if (textCompareBuffersRestored) return;
  if (typeof localStorage === 'undefined') return;
  textCompareBuffersRestored = true;
  try {
    const raw = localStorage.getItem(TEXT_COMPARE_BUFFERS_KEY);
    if (!raw) return;
    const restored = normalizeTextCompareBuffers(JSON.parse(raw));
    if (restored) $textCompareBuffers.set(restored);
  } catch {
    /* ignore corrupt or blocked storage */
  }
}

$textCompareBuffers.listen((value) => {
  if (typeof localStorage === 'undefined') return;
  try {
    const total = value.comparisons.reduce((n, c) => n + c.left.length + c.right.length, 0);
    if (total > TEXT_COMPARE_PERSIST_MAX) {
      localStorage.removeItem(TEXT_COMPARE_BUFFERS_KEY);
      return;
    }
    localStorage.setItem(TEXT_COMPARE_BUFFERS_KEY, JSON.stringify(value));
  } catch {
    /* ignore quota errors or blocked storage */
  }
});

// ── Text Compare comparison actions — the ONLY way the UI mutates the store ───
/** Open a new, empty comparison and make it the active tab. */
export function addTextComparison(): void {
  const state = $textCompareBuffers.get();
  const comparison: TextComparison = {
    id: nextComparisonId('text'),
    name: nextComparisonName(state.comparisons),
    left: '', right: '', leftName: '', rightName: '',
  };
  $textCompareBuffers.set({ ...state, comparisons: [...state.comparisons, comparison], activeId: comparison.id });
}
/**
 * Close the comparison with `id`. The last remaining comparison is never removed
 * (there is always at least one tab). When the active tab is closed, the
 * neighbour that slides into its slot becomes active.
 */
export function closeTextComparison(id: string): void {
  const state = $textCompareBuffers.get();
  if (state.comparisons.length <= 1) return; // never remove the last tab
  const index = state.comparisons.findIndex((c) => c.id === id);
  if (index === -1) return;
  const comparisons = state.comparisons.filter((c) => c.id !== id);
  let activeId = state.activeId;
  if (activeId === id) activeId = comparisons[Math.min(index, comparisons.length - 1)].id;
  $textCompareBuffers.set({ ...state, comparisons, activeId });
}
/** Make the comparison with `id` the active tab (a no-op if already active or unknown). */
export function setActiveTextComparison(id: string): void {
  const state = $textCompareBuffers.get();
  if (state.activeId === id) return;
  if (!state.comparisons.some((c) => c.id === id)) return;
  $textCompareBuffers.setKey('activeId', id);
}
/** Patch the active comparison's texts and/or labels in place. */
export function updateActiveTextComparison(
  patch: Partial<Pick<TextComparison, 'left' | 'right' | 'leftName' | 'rightName'>>,
): void {
  const state = $textCompareBuffers.get();
  const comparisons = state.comparisons.map((c) => (c.id === state.activeId ? { ...c, ...patch } : c));
  $textCompareBuffers.setKey('comparisons', comparisons);
}
/** Clear the active comparison's texts and labels (keeps the tab open). */
export function clearActiveTextComparison(): void {
  updateActiveTextComparison({ left: '', right: '', leftName: '', rightName: '' });
}
/**
 * Seed the first comparison's Left from the shared document the first time the
 * Text Compare tool is opened this session, so the content the user was viewing
 * flows into the comparison (Req 21.5/21.6). A no-op once seeded (including when
 * buffers were restored from storage, which sets `seeded`).
 */
export function seedTextLeftIfNeeded(text: string): void {
  const state = $textCompareBuffers.get();
  if (state.seeded) return;
  const comparisons = state.comparisons.map((c, i) => (i === 0 ? { ...c, left: text } : c));
  $textCompareBuffers.set({ ...state, comparisons, seeded: true });
}

// ---------------------------------------------------------------------------
// $activeTool — which tool is active
// ---------------------------------------------------------------------------

/** The five primary tools, matching the navigation entries (Req 21.1). */
export type Tool = 'viewer' | 'diff' | 'grid' | 'converter' | 'text';

/** The currently active tool. Defaults to the Viewer. */
export const $activeTool = atom<Tool>('viewer');

/** Set the active tool. */
export function setActiveTool(tool: Tool): void {
  $activeTool.set(tool);
}

// ---------------------------------------------------------------------------
// $settings — UI / user settings
// ---------------------------------------------------------------------------

/** UI/user settings shared across tools. */
export interface Settings {
  /** Indentation style used by the Formatter (2-space, 4-space, or tab). */
  indentStyle: IndentStyle;
  /** Whether rich-media inference (previews, swatches, links) is enabled (Req 12.6). */
  richMediaEnabled: boolean;
}

/** Default settings: 2-space indentation with rich media enabled. */
const DEFAULT_SETTINGS: Settings = {
  indentStyle: { kind: 'space', size: 2 },
  richMediaEnabled: true,
};

/** Shared UI/user settings. */
export const $settings = map<Settings>({ ...DEFAULT_SETTINGS });

/** Set the indentation style used when formatting (Req 5.1–5.3). */
export function setIndentStyle(indentStyle: IndentStyle): void {
  $settings.setKey('indentStyle', indentStyle);
}

/** Enable or disable rich-media inference (Req 12.6). */
export function setRichMediaEnabled(enabled: boolean): void {
  $settings.setKey('richMediaEnabled', enabled);
}
