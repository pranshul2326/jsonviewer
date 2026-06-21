/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 13.9
//
// ViewerPanel: the assembled Viewer tool. It composes the existing pieces into
// the full viewer/editor surface (Req 1):
//
//   • EditorPane (left)  — the Monaco editor bound to the shared `$document`,
//     where the user types/pastes/edits the raw JSON text (Req 6 validation is
//     owned by EditorPane).
//   • TreePanel (right)  — the virtualized collapsible tree, rendering one
//     `TreeRow` per visible node from the parsed model. Its built-in toolbar is
//     suppressed; ViewerPanel renders the collapse-all / expand-all controls and
//     drives them through the `TreePanelApi` surfaced via `onApi`.
//   • StatusBar (bottom) — the validity indicator and document size.
//
// Requirements wired here:
//   • Req 1.4 — a "Collapse all" control drives `api.collapseAll()` so only the
//     root row remains visible.
//   • Req 1.5 — an "Expand all" control drives `api.expandAll()` so every node
//     becomes visible.
//   • Req 1.7 — when the editor content is not valid JSON, the validation error
//     state (Req 6.4: error description + 1-based line:column) is shown in place
//     of the tree. Empty/whitespace-only input is valid (Req 6.3) and simply
//     shows an empty-document hint rather than an error.
//
// Node edits flow through TreeRow's pure edit helpers; on a successful commit
// ViewerPanel serializes the new model and writes it back to the shared editor
// text via `setDocumentText`, which re-parses and updates every consumer
// (round-trip, Req 2.8). The serialization uses the shared `serialize` so object
// key order, array order, and numeric precision are preserved verbatim.

import { useStore } from '@nanostores/preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { $document, $settings, setDocumentText } from '../../lib/stores/document';
import { format, minify } from '../../lib/json-core/serialize';
import type { JsonNode } from '../../lib/json-core/types';
import type { ParseResult } from '../../lib/json-core/parse';
import { EditorPane } from '../app/EditorPane';
import { StatusBar } from '../app/StatusBar';
import { TreePanel, type FlatRow, type RowHandlers, type TreePanelApi } from './TreePanel';
import { TreeRow } from './TreeRow';

/**
 * The validation error state for the Viewer (Req 1.7 → Req 6.4): the error
 * description together with the first error's 1-based line:column. Mirrors the
 * shared presenter used by StatusBar / MergePanel / SemanticDiffList so the
 * error surface is consistent across tools.
 */
function ValidationError({ error }: { error: Extract<ParseResult, { ok: false }>['error'] }) {
  return (
    <div
      class="flex min-h-[40vh] flex-col items-center justify-center gap-sm p-xl text-center"
      role="alert"
      data-region="viewer-error"
    >
      <p
        class="inline-flex items-center gap-1.5 font-sans text-body-sm text-error"
        data-status="error"
        title={error.message}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.25" />
          <line x1="8" y1="4.75" x2="8" y2="8.75" />
          <line x1="8" y1="11" x2="8" y2="11.25" />
        </svg>
        <span class="max-w-[48ch]">{error.message}</span>
      </p>
      <span class="font-mono text-caption-mono text-error-deep">
        Line {error.line}, column {error.column}
      </span>
    </div>
  );
}

/** The empty-document hint shown for valid-empty input (Req 6.3, no error). */
function EmptyDocument() {
  return (
    <div
      class="flex min-h-[40vh] items-center justify-center p-xl text-center text-body-sm text-mute"
      data-region="viewer-empty"
    >
      Paste or type JSON in the editor to explore it as a tree.
    </div>
  );
}

/** Props for {@link ViewerPanel}. */
export interface ViewerPanelProps {
  /**
   * Progress of an in-flight long-running worker operation, forwarded to the
   * StatusBar (Req 17.3). When omitted no progress indicator is shown.
   */
  progress?: number | null;
  /** Optional label for the in-flight operation shown by the StatusBar. */
  progressLabel?: string;
  /**
   * Compact embed (e.g. on the marketing homepage). When true the editor/tree
   * reserve a shorter, bounded desktop height instead of nearly the full
   * viewport, so server-rendered content below the workbench (SEO copy, FAQ)
   * stays visible without a long scroll. The dedicated tool page leaves this
   * off and uses the full height.
   */
  compact?: boolean;
}

/**
 * The assembled Viewer panel: editor on the left, collapsible tree on the right
 * (or the validation error state when the content is invalid), and the status
 * bar beneath. Collapse-all / expand-all controls drive the tree.
 */
export default function ViewerPanel({ progress, progressLabel, compact = false }: ViewerPanelProps = {}) {
  const doc = useStore($document);
  const settings = useStore($settings);

  // Desktop sizing for the editor/tree panes.
  //   • Full page (default): a tall height close to the full viewport so the
  //     editor/tree are large, similar to the Grid and Converter tools.
  //   • Compact embed (homepage): a shorter bounded height so the SEO/FAQ copy
  //     below the workbench stays visible.
  const paneHeightClass = compact ? 'md:h-[55vh]' : 'md:h-[calc(100dvh-7rem)]';
  const paneMinHeightClass = compact ? 'md:min-h-[55vh]' : 'md:min-h-[calc(100dvh-7rem)]';

  // The imperative tree controls, captured once TreePanel mounts (Req 1.4/1.5).
  const treeApiRef = useRef<TreePanelApi | null>(null);
  const onTreeApi = useCallback((api: TreePanelApi) => {
    treeApiRef.current = api;
  }, []);

  const expandAll = () => treeApiRef.current?.expandAll();
  const collapseAll = () => treeApiRef.current?.collapseAll();

  const { parsed } = doc;
  // The tree is shown only for a valid, non-empty model. An invalid document
  // shows the validation error state instead (Req 1.7); valid-empty shows the
  // empty-document hint (Req 6.3).
  const model: JsonNode | null = parsed.ok && !parsed.empty ? parsed.model : null;
  const hasTree = model !== null;

  /**
   * Apply a node edit committed by a TreeRow: serialize the new model and write
   * it back to the shared editor text, which re-parses and updates every
   * consumer (round-trip, Req 2.8).
   */
  const onCommit = useCallback((nextModel: JsonNode) => {
    // Re-emit using the selected indentation (NOT the compact serializer) so a
    // tree edit keeps the editor text formatted rather than minifying it.
    setDocumentText(format(nextModel, settings.indentStyle));
    setEditError(null);
    setActiveEditId(null);
  }, [settings.indentStyle]);

  /**
   * Beautify the editor text using the active indentation style (Req 5.1–5.3).
   * No-op when the document is empty or invalid (Req 5.7/5.8).
   */
  const onFormat = useCallback(() => {
    if (model) setDocumentText(format(model, settings.indentStyle));
  }, [model, settings.indentStyle]);

  /**
   * Minify the editor text — strip whitespace outside string literals
   * (Req 5.4). String-literal aware, so it only runs on valid JSON.
   */
  const onMinify = useCallback(() => {
    if (model) setDocumentText(minify(doc.text));
  }, [model, doc.text]);

  // ── Resizable editor/tree split ──────────────────────────────────────────
  // The middle divider is draggable so the user can size the editor (left) and
  // the tree (right) panes. Active only on the wide (side-by-side) layout; on
  // narrow screens the panes stack and the divider is hidden.
  const splitRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [leftPct, setLeftPct] = useState(55);
  const [isWide, setIsWide] = useState(true);
  // Edit-rejection message (duplicate key / invalid scalar), surfaced in the
  // tree toolbar rather than as a per-row box.
  const [editError, setEditError] = useState<string | null>(null);
  // The single row currently being edited (id), so opening one editor closes
  // any other (only one active editor at a time across the tree).
  const [activeEditId, setActiveEditId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      // Environments without matchMedia (e.g. jsdom in tests): assume the wide
      // side-by-side layout and skip the responsive listener.
      setIsWide(true);
      return;
    }
    const mq = window.matchMedia('(min-width: 768px)');
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const onDividerPointerDown = useCallback((event: PointerEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }, []);

  const onDividerPointerMove = useCallback((event: PointerEvent) => {
    if (!draggingRef.current || !splitRef.current) return;
    const rect = splitRef.current.getBoundingClientRect();
    if (rect.width === 0) return;
    const pct = ((event.clientX - rect.left) / rect.width) * 100;
    // Clamp so neither pane collapses entirely.
    setLeftPct(Math.min(80, Math.max(20, pct)));
  }, []);

  const onDividerPointerUp = useCallback((event: PointerEvent) => {
    draggingRef.current = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }, []);

  /** Reset the split to the default 55/45 (double-click the divider). */
  const resetSplit = useCallback(() => setLeftPct(55), []);

  // Render the full TreeRow for each visible row, threaded with the current
  // model, the rich-media setting, and the commit handler.
  const renderRow = useCallback(
    (row: FlatRow, handlers: RowHandlers) =>
      model ? (
        <TreeRow
          row={row}
          handlers={handlers}
          root={model}
          onCommit={onCommit}
          richMediaEnabled={settings.richMediaEnabled}
          onError={setEditError}
          activeEditId={activeEditId}
          onActiveEditChange={setActiveEditId}
        />
      ) : (
        // Unreachable while `hasTree` gates rendering, but keeps the renderer
        // total for the prop's type.
        <span />
      ),
    [model, onCommit, settings.richMediaEnabled, activeEditId],
  );

  return (
    <section
      aria-label="Viewer panel"
      data-tool-panel="viewer"
      class="flex flex-col"
    >
      {/* Editor + tree, side by side (stacked on narrow screens). Each pane has
          its own height; a draggable divider resizes the two on the wide
          layout. `items-start` lets each pane be its own height rather than
          stretching to the taller one. */}
      <div ref={splitRef} class="flex flex-col md:flex-row md:items-start">
        {/* Editor (left): a toolbar (Format / Minify) over the Monaco editor.
            The editor auto-sizes to its content (capped), so a folded/short
            document leaves no empty canvas. */}
        <div
          class={`flex h-[45vh] min-w-0 flex-col border-b border-hairline ${paneHeightClass} md:border-b-0`}
          style={isWide ? { flex: `0 0 ${leftPct}%` } : undefined}
        >
          <div class="flex items-center gap-xs border-b border-hairline px-sm py-xs">
            <button
              type="button"
              class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onFormat}
              disabled={!hasTree}
              title="Beautify / indent the JSON (also Ctrl/Cmd+Shift+F)"
            >
              Format
            </button>
            <button
              type="button"
              class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onMinify}
              disabled={!hasTree}
              title="Minify the JSON to a single line"
            >
              Minify
            </button>
          </div>
          <div class="min-h-0 flex-1 min-w-0 overflow-hidden">
            <EditorPane />
          </div>
        </div>

        {/* Draggable divider (wide layout only): a thin 1px line inside a wider
            transparent grab area so it is easy to grab but visually slim. Drag
            to resize; double-click to reset to the default split. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize editor and tree panes"
          class="hidden w-2 shrink-0 cursor-col-resize touch-none select-none items-stretch justify-center self-stretch bg-transparent hover:bg-link/10 active:bg-link/20 md:flex"
          onPointerDown={onDividerPointerDown}
          onPointerMove={onDividerPointerMove}
          onPointerUp={onDividerPointerUp}
          onDblClick={resetSplit}
        >
          <div class="h-full w-px bg-hairline" />
        </div>

        {/* Tree / validation error state (right). */}
        <div class={`flex min-h-[50vh] min-w-0 flex-col ${paneMinHeightClass}`} style={{ flex: '1 1 0' }}>
          {/* Tree controls: collapse-all (Req 1.4) and expand-all (Req 1.5).
              Disabled when there is no tree to act on. */}
          <div class="flex items-center gap-xs border-b border-hairline px-sm py-xs">
            <button
              type="button"
              class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft disabled:cursor-not-allowed disabled:opacity-50"
              onClick={expandAll}
              disabled={!hasTree}
            >
              Expand all
            </button>
            <button
              type="button"
              class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft disabled:cursor-not-allowed disabled:opacity-50"
              onClick={collapseAll}
              disabled={!hasTree}
            >
              Collapse all
            </button>
            {/* Edit-rejection message (Req 2.5/2.6/2.7), shown inline after the
                tree controls — plain text, no box. */}
            {editError ? (
              <span
                class="ml-sm min-w-0 truncate text-caption text-error"
                role="alert"
                data-testid="edit-error"
                title={editError}
              >
                {editError}
              </span>
            ) : null}
          </div>

          <div class="min-w-0">
            {hasTree ? (
              <TreePanel
                root={model}
                showControls={false}
                onApi={onTreeApi}
                renderRow={renderRow}
              />
            ) : parsed.ok ? (
              // Valid-empty input (Req 6.3): no error, just a hint.
              <EmptyDocument />
            ) : (
              // Invalid JSON (Req 1.7 → Req 6.4): validation error state.
              <ValidationError error={parsed.error} />
            )}
          </div>
        </div>
      </div>

      {/* Status bar (validity + size + worker progress). */}
      <StatusBar progress={progress} progressLabel={progressLabel} />
    </section>
  );
}
