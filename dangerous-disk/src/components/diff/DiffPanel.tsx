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

// Monaco's codicon icon styles, imported statically as CSS so the bundler folds
// them into the eager island stylesheet. See EditorPane.tsx for the full
// rationale: routing this through a dynamic `import('…/codiconStyles.js')` made
// Vite emit a `__vitePreload` <link> to a CSS chunk that was never built in the
// production bundle, so the preload 404'd and the rejection aborted the diff
// editor's mount. A static CSS import removes that failure mode entirely.
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';

// Monaco's CORE editor/diff layout CSS (`.monaco-editor`, `.view-lines`,
// `.view-line`, and the diff overlays). Without it the diff editor renders its
// lines overlapping/incomplete because Monaco only sets per-line inline offsets
// and relies on this stylesheet for the layout. The ESM build scattered these
// rules into a dynamic CSS chunk that the production build dropped (same mode
// as the codicon CSS above), so the deployed diff looked broken while
// `astro dev` was fine. `min/vs/editor/editor.main.css` is the single
// concatenated stylesheet; importing it statically guarantees it ships.
import 'monaco-editor/min/vs/editor/editor.main.css';

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
  /** Optional label for the Left document, shown as an editable field in the banner. */
  leftName?: string;
  /** Optional label for the Right document, shown as an editable field in the banner. */
  rightName?: string;
  /** Called with the new Left label when the user edits the left file-name field. */
  onLeftNameChange?: (name: string) => void;
  /** Called with the new Right label when the user edits the right file-name field. */
  onRightNameChange?: (name: string) => void;
  /**
   * Clear both documents (and their labels). When provided, a "Clear" button is
   * shown in the toolbar. The composing parent owns the reset so the shared
   * buffers and persisted storage are wiped in one place.
   */
  onClear?: () => void;
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
  'inline-flex items-center whitespace-nowrap font-sans text-button-md rounded-md px-3 py-1.5 ' +
  'transition-colors cursor-pointer select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50';
const TOGGLE_ACTIVE = 'bg-canvas text-ink shadow-level-1';
const TOGGLE_INACTIVE = 'text-body hover:text-ink';

/**
 * Shared classes for the editable Left/Right file-name fields in the banner.
 * A borderless field that reveals a hairline ring on hover and a link ring on
 * focus, so it reads as a quiet label until the user interacts with it.
 */
const NAME_FIELD_BASE =
  'min-w-0 rounded-sm bg-transparent px-2 py-0.5 font-sans text-body-sm text-ink ' +
  'placeholder:text-mute ring-1 ring-inset ring-transparent transition-colors ' +
  'hover:ring-hairline focus:outline-none focus:ring-2 focus:ring-link/50';

/**
 * An inner diff pane whose scroll-position setters we may have shadowed to
 * decouple it from the other pane (see {@link setDiffScrollSync}). The saved
 * originals are stashed under non-enumerable-ish private keys so the patch is
 * fully reversible.
 */
type ScrollPatchablePane = Monaco.editor.ICodeEditor & {
  __jvfSetScrollTop?: Monaco.editor.ICodeEditor['setScrollTop'];
  __jvfSetScrollLeft?: Monaco.editor.ICodeEditor['setScrollLeft'];
};

/**
 * Enable or disable scroll synchronization between the Left (original) and
 * Right (modified) panes of a Monaco diff editor.
 *
 * Monaco's diff editor force-syncs the two panes through internal reactive
 * autoruns that call each inner editor's `setScrollTop` / `setScrollLeft` to
 * keep their offsets aligned. There is no public option to turn this off.
 * Crucially, user wheel and drag scrolling does NOT go through those public
 * methods — it updates the editor's view layout directly and merely emits
 * `onDidScrollChange`. So to let the user scroll the panes independently we
 * shadow `setScrollTop` / `setScrollLeft` on each inner editor instance with
 * no-ops: Monaco's cross-pane sync becomes inert while genuine user scrolling
 * keeps working. Restoring the saved originals (and nudging a one-time
 * re-align) re-enables the native synchronized behavior.
 *
 * The instances returned by `getOriginalEditor()` / `getModifiedEditor()` are
 * the exact ones Monaco's autoruns drive, so patching them here is sufficient.
 */
function setDiffScrollSync(
  editor: Monaco.editor.IStandaloneDiffEditor,
  enabled: boolean,
): void {
  const panes = [
    editor.getOriginalEditor(),
    editor.getModifiedEditor(),
  ] as ScrollPatchablePane[];

  for (const pane of panes) {
    if (enabled) {
      // Restore the native setters so Monaco's autoruns can sync again.
      if (pane.__jvfSetScrollTop) {
        pane.setScrollTop = pane.__jvfSetScrollTop;
        pane.setScrollLeft = pane.__jvfSetScrollLeft!;
        delete pane.__jvfSetScrollTop;
        delete pane.__jvfSetScrollLeft;
      }
    } else if (!pane.__jvfSetScrollTop) {
      // Neutralize Monaco's programmatic cross-sync (idempotent): save the
      // originals once, then replace them with no-ops.
      pane.__jvfSetScrollTop = pane.setScrollTop.bind(pane);
      pane.__jvfSetScrollLeft = pane.setScrollLeft.bind(pane);
      pane.setScrollTop = () => {};
      pane.setScrollLeft = () => {};
    }
  }

  if (enabled) {
    // Re-align once on re-enable: pull the original pane to the modified pane's
    // current offset. Monaco then keeps them aligned on the next scroll.
    const modified = editor.getModifiedEditor();
    editor.getOriginalEditor().setScrollTop(modified.getScrollTop());
  }
}

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
  leftName = '',
  rightName = '',
  onLeftNameChange,
  onRightNameChange,
  onClear,
  differenceCount = null,
}: DiffPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest change callbacks, read inside the mount effect without
  // re-subscribing (the effect runs once and keeps Monaco's models alive).
  const onLeftChangeRef = useRef(onLeftChange);
  onLeftChangeRef.current = onLeftChange;
  const onRightChangeRef = useRef(onRightChange);
  onRightChangeRef.current = onRightChange;
  // Latest Left/Right text from the composing parent. Read when the models are
  // created so a late seed (e.g. buffers restored from storage after a refresh,
  // which arrives a tick after mount) is honored, and watched by the sync
  // effects below to push external changes into the live models.
  const initialLeftRef = useRef(initialLeft);
  initialLeftRef.current = initialLeft;
  const initialRightRef = useRef(initialRight);
  initialRightRef.current = initialRight;

  // ── UI state (drives the banners; the editor content lives in Monaco) ──────
  // Always default to the side-by-side layout so the Diff Checker presents two
  // distinct, editable panes (Left = original, Right = modified) where the user
  // can paste/compare two documents. Previously this defaulted to the unified
  // single-pane layout on phone-width screens (≤640px), which showed only one
  // pane and made the original side read-only inline — so users on narrower
  // viewports saw "only one side" and couldn't paste into the left document.
  // The view toggle remains fully functional, so unified is still one click
  // away for anyone who prefers it.
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  // Whether the two panes scroll together (default) or independently. Only
  // meaningful in the side-by-side layout; the toggle is offered there and is
  // enabled only once the documents actually differ.
  const [syncScroll, setSyncScroll] = useState(true);
  // Whether the diff editor is expanded to fill the whole viewport. A CSS-based
  // fullscreen (fixed inset-0) is used rather than the native Fullscreen API so
  // the app's design tokens, dark mode, and chrome continue to apply unchanged.
  const [isFullscreen, setIsFullscreen] = useState(false);
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
  // Flips true once the Monaco models exist. The external-sync effects below
  // depend on it so buffers restored from storage *before* Monaco finished
  // loading (a page refresh) are still pushed into the editors once they mount —
  // without it, the [initialLeft]/[initialRight] effects had already run against
  // null models and never re-ran, leaving the restored text invisible.
  const [modelsReady, setModelsReady] = useState(false);

  // ── Monaco handles (populated by the async client-only setup) ──────────────
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  // Latest view mode, read inside the async setup without re-subscribing.
  const viewModeRef = useRef<ViewMode>(viewMode);
  viewModeRef.current = viewMode;
  // Latest sync-scroll choice, applied to the editor once it is created.
  const syncScrollRef = useRef(syncScroll);
  syncScrollRef.current = syncScroll;

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
    // Handle for the in-flight "jump to next difference" scroll animation, so a
    // new click cancels the previous animation and cleanup can stop it.
    let scrollAnimationFrame: number | null = null;

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
      // The codicon icon font (fold chevrons etc.) is imported statically as
      // CSS at the top of this module, so it ships in the eager bundle and
      // needs no dynamic preload here.
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
        // Honor the side-by-side choice at any width. Monaco otherwise auto-
        // collapses to the inline layout below its ~900px breakpoint, which
        // made the "Side by side" toggle appear to do nothing on phones. With
        // this off, the two panes always render when side-by-side is selected
        // (each pane scrolls horizontally on small screens).
        useInlineViewWhenSpaceIsLimited: false,
        originalEditable: true, // Left pane is an editable document input.
        readOnly: false, // Right pane editable too.
        automaticLayout: true,
        minimap: { enabled: false },
        // Show the glyph margin so we can render our own clickable green/red
        // "jump to next difference" arrows next to each changed line, and turn
        // off Monaco's default per-change revert arrow (which would otherwise
        // sit in the same spot and revert the change instead of navigating).
        glyphMargin: true,
        renderMarginRevertIcon: false,
        scrollBeyondLastLine: false,
        // Let the wheel chain to the page once the editor reaches a scroll end,
        // so long JSON can be scrolled through to the very bottom/top (matches
        // the Viewer's editor behavior).
        scrollbar: { alwaysConsumeMouseWheel: false },
        renderOverviewRuler: false,
        ignoreTrimWhitespace: false,
        // Wrap long lines instead of scrolling them sideways. Without a
        // horizontal scrollbar Monaco reserves no scrollbar band at the bottom
        // of the scroll area, so the final line (e.g. the closing `}`) sits
        // flush against the pane's bottom edge, and long JSON values stay fully
        // visible. Matches the Text Compare tool's editor.
        wordWrap: 'on',
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        fontSize: 13,
        lineHeight: 20,
      });

      const original = monaco.editor.createModel(initialLeftRef.current, 'json');
      const modified = monaco.editor.createModel(initialRightRef.current, 'json');
      // `tabSize` is a model-level option (not a diff-editor construction
      // option), so it is set here on each document model.
      original.updateOptions({ tabSize: 2 });
      modified.updateOptions({ tabSize: 2 });
      editor.setModel({ original, modified });
      originalModelRef.current = original;
      modifiedModelRef.current = modified;
      editorRef.current = editor;
      // Signal that the models exist so the external-sync effects reconcile the
      // editors against the latest (possibly just-restored) buffers.
      setModelsReady(true);

      // ── Clickable gutter arrows that jump to the next difference ───────────
      // How many lines of context to keep above the target (so the difference
      // lands on the 4th visible line) and how long the scroll animation takes
      // (a longer duration reads as a slower glide). Shared behavior with the
      // Text Compare tool.
      const LINES_ABOVE_TARGET = 3;
      const SCROLL_DURATION_MS = 650;
      const modifiedEditor = editor.getModifiedEditor();
      // One arrow glyph per change, keyed on the modified-side start line.
      const glyphs = modifiedEditor.createDecorationsCollection([]);

      /**
       * Set the modified pane's scroll offset, bypassing the Sync-Scroll shim.
       * When Sync Scroll is OFF, `setScrollTop` is shadowed with a no-op on the
       * pane (see {@link setDiffScrollSync}); the native setter is saved under a
       * private key, so we call that when present. When Sync Scroll is ON the
       * setter is native and Monaco mirrors the scroll to the other pane.
       */
      const setPaneScrollTop = (pane: ScrollPatchablePane, top: number) => {
        const native = pane.__jvfSetScrollTop ?? pane.setScrollTop.bind(pane);
        native(top);
      };

      /**
       * Animate the modified pane from its current scroll offset to `to` over
       * SCROLL_DURATION_MS with an ease-in-out curve, so jumping to the next
       * difference is a slow, followable glide rather than an instant snap.
       */
      const animateScrollTo = (pane: ScrollPatchablePane, to: number) => {
        const from = pane.getScrollTop();
        const distance = to - from;
        if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame);
        if (Math.abs(distance) < 1) {
          setPaneScrollTop(pane, to);
          return;
        }
        const start = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / SCROLL_DURATION_MS);
          const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
          setPaneScrollTop(pane, from + distance * eased);
          if (t < 1 && !disposed) {
            scrollAnimationFrame = requestAnimationFrame(step);
          } else {
            scrollAnimationFrame = null;
          }
        };
        scrollAnimationFrame = requestAnimationFrame(step);
      };

      // Refresh the arrow glyphs whenever Monaco recomputes the line diff.
      subscriptions.push(
        editor.onDidUpdateDiff(() => {
          if (disposed || !editor || !monaco) return;
          const changes = editor.getLineChanges() ?? [];
          const decorations = changes.map((change) => {
            // A pure deletion has no lines on the modified side; anchor its
            // marker at the line the removed content sat before. Additions and
            // modifications anchor at their first modified line.
            const isDeletion = change.modifiedEndLineNumber === 0;
            const line = Math.max(1, change.modifiedStartLineNumber);
            return {
              range: new monaco!.Range(line, 1, line, 1),
              options: {
                glyphMarginClassName: `jvf-diff-arrow ${
                  isDeletion ? 'jvf-diff-arrow-del' : 'jvf-diff-arrow-add'
                }`,
                glyphMarginHoverMessage: { value: 'Go to next difference' },
                stickiness:
                  monaco!.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            };
          });
          // When at least one difference exists, always show a green arrow on
          // line 1 as a default entry point for stepping through the changes —
          // unless a change already sits on line 1 (which would double it up).
          if (
            decorations.length > 0 &&
            !decorations.some((d) => d.range.startLineNumber === 1)
          ) {
            decorations.unshift({
              range: new monaco!.Range(1, 1, 1, 1),
              options: {
                glyphMarginClassName: 'jvf-diff-arrow jvf-diff-arrow-add',
                glyphMarginHoverMessage: { value: 'Go to first difference' },
                stickiness:
                  monaco!.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            });
          }
          // Mirror that with a green UP arrow on the LAST line that jumps back
          // to the very top of the document — unless a change already sits on
          // the last line, or the document is a single line (which would
          // collide with the line-1 arrow above).
          const lastLine = modifiedEditor.getModel()?.getLineCount() ?? 1;
          if (
            decorations.length > 0 &&
            lastLine > 1 &&
            !decorations.some((d) => d.range.startLineNumber === lastLine)
          ) {
            decorations.push({
              range: new monaco!.Range(lastLine, 1, lastLine, 1),
              options: {
                glyphMarginClassName:
                  'jvf-diff-arrow jvf-diff-arrow-add jvf-diff-arrow-up',
                glyphMarginHoverMessage: { value: 'Scroll to top' },
                stickiness:
                  monaco!.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            });
          }
          glyphs.set(decorations);
        }),
      );

      // Clicking an arrow glyph jumps to the NEXT difference and slowly scrolls
      // it to a fixed spot near the top of the viewport (the 4th line).
      subscriptions.push(
        modifiedEditor.onMouseDown((event) => {
          if (
            !monaco ||
            event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
          ) {
            return;
          }
          const clickedLine = event.target.position?.lineNumber ?? 0;
          // The bottom entry-point glyph is an UP arrow that jumps back to the
          // top of the document; every other arrow steps to the NEXT (nearest
          // below) difference. Read the direction off the clicked glyph's class.
          const goUp = !!(
            event.target.element as HTMLElement | null
          )?.closest?.('.jvf-diff-arrow-up');
          const modEd = editorRef.current?.getModifiedEditor() as ScrollPatchablePane;
          if (!modEd) return;
          // Up arrow: glide to the very top of the document (line 1).
          if (goUp) {
            modEd.setPosition({ lineNumber: 1, column: 1 });
            animateScrollTo(modEd, 0);
            modEd.focus();
            return;
          }
          // Down arrows: jump to the next difference below the clicked arrow,
          // wrapping to the first, and glide it to the 4th visible line.
          const changes = editorRef.current?.getLineChanges() ?? [];
          const lines = changes
            .map((change) => Math.max(1, change.modifiedStartLineNumber))
            .sort((a, b) => a - b);
          if (lines.length === 0) return;
          const target = lines.find((line) => line > clickedLine) ?? lines[0];
          modEd.setPosition({ lineNumber: target, column: 1 });
          const topLine = Math.max(1, target - LINES_ABOVE_TARGET);
          animateScrollTo(modEd, modEd.getTopForLineNumber(topLine));
          modEd.focus();
        }),
      );

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

      // Apply the current Sync Scroll choice to the freshly-created editor
      // (default is synced; only acts if the user has already turned it off).
      setDiffScrollSync(editor, syncScrollRef.current);

      // Follow live app theme toggles: re-apply the matching diff theme when
      // the user flips dark mode while the diff editor is mounted.
      unsubscribeTheme = onAppThemeChange(() => {
        if (monaco) applyMonacoTheme(monaco, 'diff');
      });
    })();

    return () => {
      disposed = true;
      clearDebounce();
      if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame);
      for (const sub of subscriptions) sub.dispose();
      unsubscribeTheme?.();
      diffClient?.dispose(true);
      diffClient = null;
      // Dispose the diff editor BEFORE its text models. Disposing a model that
      // is still attached to the diff widget makes Monaco throw "TextModel got
      // disposed before DiffEditorWidget model got reset" during teardown
      // (seen when rapidly switching tools). Detaching + disposing the editor
      // first lets the widget release the models cleanly.
      editorRef.current = null;
      editor?.setModel(null);
      editor?.dispose();
      originalModelRef.current?.dispose();
      modifiedModelRef.current?.dispose();
      originalModelRef.current = null;
      modifiedModelRef.current = null;
    };
  }, []);

  // Apply the view-mode toggle to the live editor (Req 9.1/9.2).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({
      renderSideBySide: viewMode === 'side-by-side',
    });
    // Monaco's diff editor does not reliably repaint the inline (unified)
    // surface after a `renderSideBySide` toggle until its next layout pass —
    // switching modes doesn't change the container size, so `automaticLayout`'s
    // ResizeObserver never fires, leaving the unified view blank (no editor
    // background) until an unrelated resize. Force a relayout on the next frame
    // so the newly-selected view paints immediately.
    const raf = requestAnimationFrame(() => editorRef.current?.layout());
    return () => cancelAnimationFrame(raf);
  }, [viewMode]);

  // Apply the Sync Scroll toggle to the live editor: when off, the two panes
  // scroll independently; when on, Monaco's native synchronized scrolling is
  // restored (Req: independent vs. synced comparison panes).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    setDiffScrollSync(editor, syncScroll);
  }, [syncScroll]);

  // Fullscreen side effects: while expanded, lock page scroll so only the diff
  // scrolls, and let Escape collapse it. Monaco's `automaticLayout` repaints to
  // the new size via its ResizeObserver, but the container's box changes in the
  // same frame as the class swap, so we also force a relayout on the next frame
  // to avoid a one-frame blank/stale paint when entering or exiting fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

  // Force a relayout on the next frame whenever the fullscreen state flips, so
  // the diff editor paints at the new size immediately (see note above).
  useEffect(() => {
    const raf = requestAnimationFrame(() => editorRef.current?.layout());
    return () => cancelAnimationFrame(raf);
  }, [isFullscreen]);

  // Keep the live Monaco models in sync with externally-driven text changes
  // (e.g. the Left/Right buffers restored from storage after a page refresh, or
  // seeded by the parent). Guarded by a value comparison so our own edits — the
  // parent echoes them straight back as new props — never trigger a redundant
  // `setValue` (which would reset the cursor/undo stack or loop).
  useEffect(() => {
    const model = originalModelRef.current;
    if (model && model.getValue() !== initialLeft) model.setValue(initialLeft);
  }, [initialLeft, modelsReady]);
  useEffect(() => {
    const model = modifiedModelRef.current;
    if (model && model.getValue() !== initialRight) model.setValue(initialRight);
  }, [initialRight, modelsReady]);

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

  // Show the Sync Scroll toggle only once the documents actually differ; hide
  // it entirely otherwise (identical documents ⇒ nothing to scroll-compare).
  const showSyncScroll = differenceCount !== null && differenceCount > 0;
  // Within the side-by-side comparison it is actionable; in unified view there
  // is a single pane, so the control is shown but disabled with a hint.
  const syncScrollControlDisabled = viewMode === 'unified';
  const syncScrollTitle =
    viewMode === 'unified'
      ? 'Switch to “Side by side” to scroll the two panes'
      : syncScroll
        ? 'Panes scroll together — turn off to scroll independently'
        : 'Panes scroll independently — turn on to scroll together';

  return (
    <div
      class={`flex flex-col bg-canvas ${
        isFullscreen ? 'fixed inset-0 z-50 h-[100dvh] w-screen' : 'h-full'
      }`}
      data-component="diff-panel"
      data-fullscreen={isFullscreen ? 'true' : undefined}
    >
      {/* ── Toolbar: view toggle (Req 9.1 / 9.2) ───────────────────────────── */}
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-3 py-2 sm:gap-4 sm:px-4">
        <span class="font-sans text-body-sm-strong text-ink">Diff Checker</span>
        <div class="flex items-center gap-2">
          {/* Sync Scroll toggle — shown only once the documents differ. It
              applies to the side-by-side layout (two panes): when on, the panes
              scroll together; when off, each scrolls independently. */}
          {showSyncScroll && (
            <button
              type="button"
              role="switch"
              aria-checked={syncScroll}
              disabled={syncScrollControlDisabled}
              title={syncScrollTitle}
              data-control="sync-scroll"
              onClick={() => setSyncScroll((value) => !value)}
              class={`group inline-flex select-none items-center gap-2 font-sans text-button-md transition-colors focus-visible:outline-none ${
                syncScrollControlDisabled
                  ? 'cursor-not-allowed text-mute'
                  : 'cursor-pointer text-body hover:text-ink'
              }`}
            >
              {/* Track: accent when on, neutral hairline when off. */}
              <span
                class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors group-focus-visible:ring-2 group-focus-visible:ring-link/50 ${
                  syncScroll ? 'bg-link' : 'bg-hairline'
                } ${syncScrollControlDisabled ? 'opacity-50' : ''}`}
              >
                {/* Knob: elevated white puck that slides right when on. Uses the
                    Level-2 "Subtle Drop" elevation token so it lifts off the
                    track (Level 1 is only an inset hairline). */}
                <span
                  class={`inline-block h-4 w-4 rounded-full bg-canvas shadow-level-2 transition-transform duration-150 ease-in-out ${
                    syncScroll ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </span>
              Sync Scroll
            </button>
          )}
          {/* Format both documents (beautify / indent) with one click. */}
          <button
            type="button"
            class="inline-flex items-center whitespace-nowrap rounded-md px-3 py-1.5 font-sans text-button-md text-body ring-1 ring-inset ring-hairline transition-colors cursor-pointer hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
            data-action="format-both"
            title="Format both documents (beautify / indent)"
            onClick={onFormat}
          >
            Format JSON
          </button>
          {/* Clear both documents (and their labels). Parent owns the reset so
              the shared buffers + persisted storage are wiped together. */}
          {onClear && (
            <button
              type="button"
              class="inline-flex items-center whitespace-nowrap rounded-md px-3 py-1.5 font-sans text-button-md text-body ring-1 ring-inset ring-hairline transition-colors cursor-pointer hover:bg-canvas-soft hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
              data-action="clear-all"
              title="Clear both documents"
              onClick={onClear}
            >
              Clear
            </button>
          )}
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
          {/* Fullscreen / expand toggle — grows the diff editor to fill the
              whole viewport (Escape or click again to exit). */}
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-md p-1.5 text-body transition-colors cursor-pointer hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
            data-action="toggle-fullscreen"
            aria-pressed={isFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            onClick={() => setIsFullscreen((value) => !value)}
          >
            {isFullscreen ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
              </svg>
            )}
          </button>
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

      {/* ── Editable file names + difference count (Req 9.6) ──────────────────
          Three columns keep the count centered regardless of the field widths:
          the Left name sits above the left pane, the Right name above the right
          pane. */}
      {showCountBanner && (
        <div
          class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-hairline bg-canvas-soft px-4 py-2"
          data-region={differenceCount === 0 ? 'no-differences' : 'difference-summary'}
        >
          {onLeftNameChange ? (
            <input
              type="text"
              value={leftName}
              onInput={(event) =>
                onLeftNameChange((event.currentTarget as HTMLInputElement).value)
              }
              placeholder=" Original file name"
              aria-label="Left file name"
              data-field="left-name"
              class={`${NAME_FIELD_BASE} justify-self-start text-left`}
            />
          ) : (
            <span />
          )}

          <div
            class="flex items-center justify-center gap-2 justify-self-center"
            role="status"
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

          {onRightNameChange ? (
            <input
              type="text"
              value={rightName}
              onInput={(event) =>
                onRightNameChange((event.currentTarget as HTMLInputElement).value)
              }
              placeholder="Modified file name"
              aria-label="Right file name"
              data-field="right-name"
              class={`${NAME_FIELD_BASE} justify-self-end text-right`}
            />
          ) : (
            <span />
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
