/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 14.1
//
// DiffPanel — the Diff Checker's visualization surface (Req 9.1–9.7).
//
// A Monaco `IStandaloneDiffEditor` renders two JSON documents (Left = original,
// Right = modified) with native, visually distinct add / delete / modify
// styling. Both panes are editable, so the diff editor *is* the Left/Right
// document input and the live visualization at once.
//
// Behavior mapped to requirements:
//   • Req 9.1 — side-by-side view: two adjacent panes with aligned lines
//     (`renderSideBySide: true`).
//   • Req 9.2 — unified view: a single merged pane (`renderSideBySide: false`),
//     toggled by the view control.
//   • Req 9.3/9.4/9.5 — additions, deletions, and modifications are rendered in
//     distinct styles. Monaco renders an addition only on the modified side, a
//     deletion only on the original side, and a modification on BOTH sides with
//     inline character highlights — so the three are inherently distinguishable.
//     A token-driven diff theme (`jvf-diff`) maps the inserted/removed colors to
//     the design tokens (green addition, red deletion) rather than hardcoding.
//   • Req 9.6 — when the two documents are structurally identical, a
//     "No differences found" message is shown.
//   • Req 9.7 — when either document fails to parse, an error message naming the
//     offending document is shown AND the previously displayed diff is retained
//     (the Monaco models are only refreshed while both documents are valid).
//
// Monaco discipline (mirrors `EditorPane.tsx`):
//   • Monaco is imported ONLY on the client via dynamic `import()` inside an
//     effect, guarded on `typeof window`, so nothing Monaco-related runs during
//     SSR.
//   • `self.MonacoEnvironment.getWorker` builds the editor/json language workers
//     from same-origin worker chunks (Vite `?worker`), never cross-origin.
//   • Monaco's own JSON schema diagnostics are disabled; our `parseJson`
//     Validator is authoritative and drives the per-document error messages.
//   • All editor resources, timers, and listeners are torn down on unmount.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  computeDiffViewState,
  type DiffDocError,
} from './diff-view-state';
import { parseJson } from '../../lib/json-core/parse';
import { format } from '../../lib/json-core/serialize';
import { $settings } from '../../lib/stores/document';
import type { Difference } from '../../lib/json-core/diff';
import { isAnyLarge } from '../../lib/workers/large-document';
import { JobCancelledError, WorkerClient } from '../../lib/workers/worker-client';
import {
  applyMonacoTheme,
  defineMonacoThemes,
  diffThemeName,
  onAppThemeChange,
} from '../../lib/monaco-theme';
import type * as Monaco from 'monaco-editor';

/** Debounce window before re-evaluating the documents after the last edit. */
const EVALUATION_DEBOUNCE_MS = 300;

/** The two layout modes for the diff (Req 9.1 side-by-side, Req 9.2 unified). */
type ViewMode = 'side-by-side' | 'unified';

/** Props for {@link DiffPanel}. */
export interface DiffPanelProps {
  /** Initial Left (original) document text. */
  initialLeft?: string;
  /** Initial Right (modified) document text. */
  initialRight?: string;
  /**
   * Called with the Left (original) text whenever it changes in the editor.
   * Lets a composing parent (e.g. the Diff Checker tool) drive the semantic
   * difference list and patch export from the same single input surface.
   */
  onLeftChange?: (text: string) => void;
  /** Called with the Right (modified) text whenever it changes in the editor. */
  onRightChange?: (text: string) => void;
  /**
   * Total number of structural differences between the two documents, used to
   * render the centered status banner ("N differences found" / "No differences
   * found"). `null` while a document is invalid or the comparison is pending.
   */
  differenceCount?: number | null;
}

/**
 * A token-driven Monaco theme so diff add/delete colors derive from the design
 * system rather than Monaco's defaults (Req 9.3/9.4, design: Diff visualization).
 * Inserted content uses the green (cyan-deep) token; removed content uses the
 * error token. The light/dark variants live in `lib/monaco-theme.ts` so the
 * Viewer and Diff editors share one source of truth and both follow dark mode.
 */
/** Shared base classes for the view-toggle segmented control buttons. */
const TOGGLE_BASE =
  'inline-flex items-center font-sans text-button-md rounded-md px-3 py-1.5 ' +
  'transition-colors cursor-pointer select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50';
const TOGGLE_ACTIVE = 'bg-canvas text-ink shadow-level-1';
const TOGGLE_INACTIVE = 'text-body hover:text-ink';

/**
 * The Diff Checker visualization. Mounts a Monaco diff editor on the client and
 * keeps it in sync with the Left/Right document buffers, surfacing the
 * no-differences message and per-document parse errors.
 */
export function DiffPanel({
  initialLeft = '',
  initialRight = '',
  onLeftChange,
  onRightChange,
  differenceCount = null,
}: DiffPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest change callbacks, read inside the mount effect without
  // re-subscribing (the effect runs once and keeps Monaco's models alive).
  const onLeftChangeRef = useRef(onLeftChange);
  onLeftChangeRef.current = onLeftChange;
  const onRightChangeRef = useRef(onRightChange);
  onRightChangeRef.current = onRightChange;

  // ── UI state (drives the banners; the editor content lives in Monaco) ──────
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [errors, setErrors] = useState<DiffDocError[]>([]);
  // Whether the two documents are structurally identical (Req 9.6). Retained
  // across parse failures (Req 9.7), so it is updated only when both are valid.
  const [noDifferences, setNoDifferences] = useState(false);
  // True once at least one valid diff has been rendered, so the no-differences
  // message is not shown before any comparison has happened.
  const [hasResult, setHasResult] = useState(false);
  // Large_Document worker activity: progress while a worker diff runs (Req
  // 17.3) and the reason when one fails (Req 17.5, prior diff retained).
  const [workerProgress, setWorkerProgress] = useState<number | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);

  // ── Monaco handles (populated by the async client-only setup) ──────────────
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  // Latest view mode, read inside the async setup without re-subscribing.
  const viewModeRef = useRef<ViewMode>(viewMode);
  viewModeRef.current = viewMode;

  // Mount Monaco (client-only) and wire change-driven evaluation.
  useEffect(() => {
    if (typeof window === 'undefined') return; // never during SSR
    const container = containerRef.current;
    if (!container) return;

    let monaco: typeof Monaco | null = null;
    let editor: Monaco.editor.IStandaloneDiffEditor | null = null;
    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const subscriptions: Monaco.IDisposable[] = [];
    // Stops observing app theme toggles on cleanup.
    let unsubscribeTheme: (() => void) | null = null;
    // Lazily-created worker client used only to diff Large_Documents off the
    // main thread (Req 17.1). Small documents never construct it.
    let diffClient: WorkerClient | null = null;

    const getDiffClient = (): WorkerClient => {
      if (!diffClient) {
        const worker = new Worker(
          new URL('../../lib/workers/diff.worker.ts', import.meta.url),
          { type: 'module' },
        );
        diffClient = new WorkerClient(worker);
      }
      return diffClient;
    };

    const clearDebounce = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    /**
     * Re-evaluate the current Left/Right buffers and update the UI. When both
     * documents are valid the no-differences message reflects the new result;
     * when a document fails to parse the prior result is retained and an error
     * banner naming the document is shown (Req 9.6, 9.7).
     *
     * Small documents are evaluated synchronously on the main thread; when
     * either side is a Large_Document the structural comparison runs in a
     * worker so the UI stays responsive (Req 17.1/17.2), with a progress
     * indicator (Req 17.3) and the prior diff retained on failure (Req 17.5).
     */
    const evaluate = () => {
      const original = originalModelRef.current;
      const modified = modifiedModelRef.current;
      if (!original || !modified) return;

      const leftText = original.getValue();
      const rightText = modified.getValue();

      // Small documents: synchronous parse + semantic diff.
      if (!isAnyLarge(leftText, rightText)) {
        setWorkerProgress(null);
        setWorkerError(null);
        const result = computeDiffViewState(leftText, rightText);
        setErrors(result.errors);
        if (result.bothValid && result.noDifferences !== null) {
          setNoDifferences(result.noDifferences);
          setHasResult(true);
        }
        // On failure we intentionally leave `noDifferences`/`hasResult`
        // untouched, retaining the previously displayed diff result (Req 9.7).
        return;
      }

      // Large documents: dispatch the structural comparison to the worker.
      setWorkerProgress(0);
      setWorkerError(null);
      getDiffClient()
        .run<Difference[], { left: string; right: string }>(
          'diff',
          { left: leftText, right: rightText },
          {
            key: 'diff',
            onProgress: (value) => {
              if (!disposed) setWorkerProgress(value);
            },
          },
        )
        .then((differences) => {
          if (disposed) return;
          // Both documents parsed: refresh the no-differences result (Req 9.6).
          setErrors([]);
          setNoDifferences(differences.length === 0);
          setHasResult(true);
          setWorkerProgress(null);
        })
        .catch((err: unknown) => {
          // A superseded comparison (newer edit) is expected; ignore it.
          if (disposed || err instanceof JobCancelledError) return;
          // Failure (e.g. an unparsable side): retain the prior diff and show
          // the reason (Req 9.7, 17.5).
          setWorkerProgress(null);
          setWorkerError(
            err instanceof Error && err.message
              ? err.message
              : 'The comparison failed unexpectedly.',
          );
        });
    };

    const scheduleEvaluate = () => {
      clearDebounce();
      debounceTimer = setTimeout(evaluate, EVALUATION_DEBOUNCE_MS);
    };

    void (async () => {
      // Same-origin Monaco workers (Vite `?worker`), exactly as EditorPane.
      const [{ default: EditorWorker }, { default: JsonWorker }] =
        await Promise.all([
          import('monaco-editor/esm/vs/editor/editor.worker?worker'),
          import('monaco-editor/esm/vs/language/json/json.worker?worker'),
        ]);
      if (disposed) return;

      (self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment =
        {
          getWorker(_workerId: string, label: string) {
            if (label === 'json') return new JsonWorker();
            return new EditorWorker();
          },
        };

      // Narrow editor import + JSON language contribution (lean bundle).
      const editorApi = await import('monaco-editor/esm/vs/editor/editor.api');
      await import('monaco-editor/esm/vs/language/json/monaco.contribution');
      // Register the folding contribution (omitted by the lean `editor.api`
      // entry) so gutter fold controls work in the diff editor too.
      await import('monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js');
      // Inject the codicon icon font so fold chevrons render as glyphs rather
      // than missing-glyph boxes (the lean entry omits it).
      await import('monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js');
      if (disposed) return;
      monaco = editorApi as unknown as typeof Monaco;

      // Our Validator is authoritative — disable Monaco's JSON diagnostics.
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        validate: false,
        allowComments: false,
        schemaValidation: 'ignore',
        enableSchemaRequest: false,
      });

      // Token-driven diff colors (Req 9.3/9.4), with light/dark variants that
      // follow the app theme.
      defineMonacoThemes(monaco);

      editor = monaco.editor.createDiffEditor(container, {
        theme: diffThemeName(),
        // Side-by-side (Req 9.1) vs unified (Req 9.2) toggled live.
        renderSideBySide: viewModeRef.current === 'side-by-side',
        originalEditable: true, // Left pane is an editable document input.
        readOnly: false, // Right pane editable too.
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        // Let the wheel chain to the page once the editor reaches a scroll end,
        // so long JSON can be scrolled through to the very bottom/top (matches
        // the Viewer's editor behavior).
        scrollbar: { alwaysConsumeMouseWheel: false },
        renderOverviewRuler: false,
        ignoreTrimWhitespace: false,
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        fontSize: 13,
        lineHeight: 20,
      });

      const original = monaco.editor.createModel(initialLeft, 'json');
      const modified = monaco.editor.createModel(initialRight, 'json');
      // `tabSize` is a model-level option (not a diff-editor construction
      // option), so it is set here on each document model.
      original.updateOptions({ tabSize: 2 });
      modified.updateOptions({ tabSize: 2 });
      editor.setModel({ original, modified });
      originalModelRef.current = original;
      modifiedModelRef.current = modified;
      editorRef.current = editor;

      // Re-evaluate whenever either document changes, and surface the new text
      // to a composing parent (Diff Checker tool) so the semantic list and
      // patch export stay in sync with this single input surface.
      subscriptions.push(
        original.onDidChangeContent(() => {
          onLeftChangeRef.current?.(original.getValue());
          scheduleEvaluate();
        }),
      );
      subscriptions.push(
        modified.onDidChangeContent(() => {
          onRightChangeRef.current?.(modified.getValue());
          scheduleEvaluate();
        }),
      );

      // Seed banners for the initial content.
      evaluate();

      // Follow live app theme toggles: re-apply the matching diff theme when
      // the user flips dark mode while the diff editor is mounted.
      unsubscribeTheme = onAppThemeChange(() => {
        if (monaco) applyMonacoTheme(monaco, 'diff');
      });
    })();

    return () => {
      disposed = true;
      clearDebounce();
      for (const sub of subscriptions) sub.dispose();
      unsubscribeTheme?.();
      diffClient?.dispose(true);
      diffClient = null;
      originalModelRef.current?.dispose();
      modifiedModelRef.current?.dispose();
      originalModelRef.current = null;
      modifiedModelRef.current = null;
      editorRef.current = null;
      editor?.dispose();
    };
  }, []);

  // Apply the view-mode toggle to the live editor (Req 9.1/9.2).
  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: viewMode === 'side-by-side',
    });
  }, [viewMode]);

  // Format (beautify / indent) both documents in place using the shared
  // indentation setting. Each side is parsed and re-serialized; an empty or
  // invalid side is left untouched. Setting the model value triggers the normal
  // change → re-evaluate path, so the buffers and diff stay in sync.
  const onFormat = () => {
    const style = $settings.get().indentStyle;
    for (const model of [originalModelRef.current, modifiedModelRef.current]) {
      if (!model) continue;
      const result = parseJson(model.getValue());
      if (result.ok && !result.empty) {
        const formatted = format(result.model, style);
        if (formatted !== model.getValue()) model.setValue(formatted);
      }
    }
  };

  // The status banner (centered) shows the difference count once a valid
  // comparison exists and there are no outstanding parse errors: the total
  // count when the documents differ, or "No differences found" when identical.
  const showCountBanner = differenceCount !== null && errors.length === 0;

  return (
    <div class="flex h-full flex-col bg-canvas" data-component="diff-panel">
      {/* ── Toolbar: view toggle (Req 9.1 / 9.2) ───────────────────────────── */}
      <div class="flex items-center justify-between gap-4 border-b border-hairline px-4 py-2">
        <span class="font-sans text-body-sm-strong text-ink">Diff Checker</span>
        <div class="flex items-center gap-2">
          {/* Format both documents (beautify / indent) with one click. */}
          <button
            type="button"
            class="inline-flex items-center rounded-md px-3 py-1.5 font-sans text-button-md text-body ring-1 ring-inset ring-hairline transition-colors cursor-pointer hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
            data-action="format-both"
            title="Format both documents (beautify / indent)"
            onClick={onFormat}
          >
            Format JSON
          </button>
          <div
            class="inline-flex items-center gap-1 rounded-lg bg-canvas-soft-2 p-1"
            role="group"
            aria-label="Diff view mode"
          >
            <button
              type="button"
              class={`${TOGGLE_BASE} ${viewMode === 'side-by-side' ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}`}
              aria-pressed={viewMode === 'side-by-side'}
              data-view="side-by-side"
              onClick={() => setViewMode('side-by-side')}
            >
              Side by side
            </button>
            <button
              type="button"
              class={`${TOGGLE_BASE} ${viewMode === 'unified' ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}`}
              aria-pressed={viewMode === 'unified'}
              data-view="unified"
              onClick={() => setViewMode('unified')}
            >
              Unified
            </button>
          </div>
        </div>
      </div>

      {/* ── Large-document worker progress (Req 17.3) ──────────────────────── */}
      {workerProgress !== null && (
        <div
          class="flex items-center gap-2 border-b border-hairline bg-canvas-soft px-4 py-2"
          role="status"
          aria-live="polite"
          data-region="diff-progress"
        >
          <span class="font-sans text-caption text-mute">
            Comparing large documents… {Math.round(workerProgress * 100)}%
          </span>
        </div>
      )}

      {/* ── Worker failure reason; prior diff retained (Req 17.5) ───────────── */}
      {workerError && (
        <div
          class="flex items-center gap-2 border-b border-error/30 bg-error-soft px-4 py-2"
          role="alert"
          data-region="diff-worker-error"
        >
          <span class="font-sans text-body-sm text-error-deep">
            Comparison failed: {workerError}
          </span>
        </div>
      )}

      {/* ── Per-document parse errors (Req 9.7) ────────────────────────────── */}
      {errors.length > 0 && (
        <div
          class="flex flex-col gap-1 border-b border-error/30 bg-error-soft px-4 py-2"
          role="alert"
          data-region="diff-errors"
        >
          {errors.map((error) => (
            <p
              key={error.side}
              class="font-sans text-body-sm text-error-deep"
              data-error-side={error.side}
            >
              {error.message}
            </p>
          ))}
          <p class="font-sans text-caption text-error-deep/80">
            Showing the most recent successful comparison.
          </p>
        </div>
      )}

      {/* ── Difference count / no-differences message, centered (Req 9.6) ──── */}
      {showCountBanner && (
        <div
          class="flex items-center justify-center gap-2 border-b border-hairline bg-canvas-soft px-4 py-2"
          role="status"
          data-region={differenceCount === 0 ? 'no-differences' : 'difference-summary'}
        >
          {differenceCount === 0 ? (
            <>
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-success"
                aria-hidden="true"
              >
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
              <span class="font-sans text-body-sm text-body">No differences found</span>
            </>
          ) : (
            <span class="font-sans text-body-sm-strong text-ink">
              {differenceCount} {differenceCount === 1 ? 'difference' : 'differences'} found
            </span>
          )}
        </div>
      )}

      {/* ── Monaco diff editor (Req 9.1–9.5) ───────────────────────────────── */}
      <div
        ref={containerRef}
        class="min-h-0 flex-1 overflow-hidden font-mono text-code"
        data-region="diff-editor"
      />
    </div>
  );
}

export default DiffPanel;
