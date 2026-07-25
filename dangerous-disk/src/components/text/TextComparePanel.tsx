/** @jsxImportSource preact */
// Feature: json-viewer-free — Text Compare
//
// TextComparePanel — the Text Compare tool's visualization surface.
//
// It mounts a Monaco `IStandaloneDiffEditor` over two PLAIN-TEXT models (Left =
// original, Right = modified) so arbitrary text — logs, config, prose, code
// snippets — can be compared line by line. It is deliberately the leaner sibling
// of the JSON DiffPanel: there is no JSON parsing, no schema diagnostics, no
// semantic difference list and no RFC 6902 patch export. Monaco computes the
// line diff itself; we only surface a simple "N differences" / "No differences"
// banner derived from `editor.getLineChanges()`.
//
// Monaco discipline (mirrors DiffPanel/EditorPane):
//   • Monaco is imported ONLY on the client via dynamic `import()` inside an
//     effect, guarded on `typeof window`, so nothing Monaco-related runs during
//     the static SSR build.
//   • `self.MonacoEnvironment.getWorker` builds the editor worker from a
//     same-origin worker chunk (Vite `?worker`), never cross-origin. Plain text
//     needs no language worker, so only the base editor worker is wired.
//   • All editor resources, timers, and listeners are torn down on unmount.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  applyMonacoTheme,
  defineMonacoThemes,
  diffThemeName,
  onAppThemeChange,
} from '../../lib/monaco-theme';
import type * as Monaco from 'monaco-editor';

// Monaco's codicon icon styles + core editor/diff layout CSS, imported
// statically so the bundler folds them into the eager island stylesheet. See
// DiffPanel.tsx for the full rationale: routing these through dynamic imports
// made Vite emit preload <link>s to CSS chunks that the production build never
// produced, so the diff editor mounted broken in production while dev was fine.
// Static imports remove that failure mode; they are idempotent across panels.
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import 'monaco-editor/min/vs/editor/editor.main.css';

/** The two layout modes for the diff (side-by-side and unified). */
type ViewMode = 'side-by-side' | 'unified';

/** Props for {@link TextComparePanel}. */
export interface TextComparePanelProps {
  /** Initial Left (original) text. */
  initialLeft?: string;
  /** Initial Right (modified) text. */
  initialRight?: string;
  /** Called with the Left (original) text whenever it changes in the editor. */
  onLeftChange?: (text: string) => void;
  /** Called with the Right (modified) text whenever it changes in the editor. */
  onRightChange?: (text: string) => void;
  /** Optional label for the Left text, shown as an editable field in the banner. */
  leftName?: string;
  /** Optional label for the Right text, shown as an editable field in the banner. */
  rightName?: string;
  /** Called with the new Left label when the user edits the left file-name field. */
  onLeftNameChange?: (name: string) => void;
  /** Called with the new Right label when the user edits the right file-name field. */
  onRightNameChange?: (name: string) => void;
  /**
   * Clear both texts (and their labels). When provided, a "Clear" button is
   * shown in the toolbar. The composing parent owns the reset so the shared
   * buffers and persisted storage are wiped in one place.
   */
  onClear?: () => void;
  /**
   * Multi-comparison tab bar. When provided together with `onAddComparison`,
   * the toolbar renders one tab per comparison plus a "+ new compare" button.
   * Optional, so the panel stays backward-compatible when mounted without tabs.
   */
  comparisons?: { id: string; name: string }[];
  /** Id of the active comparison (the highlighted tab). */
  activeId?: string;
  /** Select the comparison with the given id (switches the active tab). */
  onSelectComparison?: (id: string) => void;
  /** Open a new, empty comparison and make it active. */
  onAddComparison?: () => void;
  /** Close the comparison with the given id (never the last remaining one). */
  onCloseComparison?: (id: string) => void;
}

/** Shared base classes for the view-toggle segmented control buttons. */
const TOGGLE_BASE =
  'inline-flex items-center whitespace-nowrap font-sans text-button-md rounded-md px-3 py-1.5 ' +
  'transition-colors cursor-pointer select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50';
const TOGGLE_ACTIVE = 'bg-canvas text-ink shadow-level-1';
const TOGGLE_INACTIVE = 'text-body hover:text-ink';

/**
 * Shared classes for the editable Left/Right file-name fields in the banner.
 * Borderless until hover/focus so it reads as a quiet label (mirrors DiffPanel).
 */
const NAME_FIELD_BASE =
  'min-w-0 rounded-sm bg-transparent px-2 py-0.5 font-sans text-body-sm text-ink ' +
  'placeholder:text-mute ring-1 ring-inset ring-transparent transition-colors ' +
  'hover:ring-hairline focus:outline-none focus:ring-2 focus:ring-link/50';

/** Shared classes for the small icon-only copy buttons in the banner. */
const COPY_BTN_BASE =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-mute ' +
  'transition-colors cursor-pointer hover:bg-canvas-soft hover:text-ink ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50';

/** Clipboard "copy" glyph (two overlapping sheets). */
function CopyGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}
/** Checkmark glyph shown briefly after a successful copy. */
function CheckGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-success" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/**
 * An inner diff pane whose scroll-position setters we may have shadowed to
 * decouple it from the other pane (see {@link setDiffScrollSync}). The saved
 * originals are stashed under private keys so the patch is fully reversible.
 */
type ScrollPatchablePane = Monaco.editor.ICodeEditor & {
  __jvfSetScrollTop?: Monaco.editor.ICodeEditor['setScrollTop'];
  __jvfSetScrollLeft?: Monaco.editor.ICodeEditor['setScrollLeft'];
};

/**
 * Enable or disable scroll synchronization between the Left and Right panes of
 * a Monaco diff editor. Monaco force-syncs the two panes through internal
 * autoruns that call each inner editor's `setScrollTop` / `setScrollLeft`; there
 * is no public option to turn this off. User wheel/drag scrolling does NOT go
 * through those setters, so shadowing them with no-ops makes Monaco's cross-pane
 * sync inert while genuine user scrolling keeps working. Restoring the saved
 * originals (and nudging a one-time re-align) re-enables native synced scrolling.
 * (Mirrors the helper in DiffPanel.tsx.)
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
      if (pane.__jvfSetScrollTop) {
        pane.setScrollTop = pane.__jvfSetScrollTop;
        pane.setScrollLeft = pane.__jvfSetScrollLeft!;
        delete pane.__jvfSetScrollTop;
        delete pane.__jvfSetScrollLeft;
      }
    } else if (!pane.__jvfSetScrollTop) {
      pane.__jvfSetScrollTop = pane.setScrollTop.bind(pane);
      pane.__jvfSetScrollLeft = pane.setScrollLeft.bind(pane);
      pane.setScrollTop = () => {};
      pane.setScrollLeft = () => {};
    }
  }

  if (enabled) {
    const modified = editor.getModifiedEditor();
    editor.getOriginalEditor().setScrollTop(modified.getScrollTop());
  }
}

/**
 * The Text Compare visualization. Mounts a Monaco diff editor over two plain-
 * text models on the client and keeps it in sync with the Left/Right buffers,
 * surfacing a line-difference count banner.
 */
export function TextComparePanel({
  initialLeft = '',
  initialRight = '',
  onLeftChange,
  onRightChange,
  leftName = '',
  rightName = '',
  onLeftNameChange,
  onRightNameChange,
  onClear,
  comparisons,
  activeId,
  onSelectComparison,
  onAddComparison,
  onCloseComparison,
}: TextComparePanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest change callbacks, read inside the mount effect without re-subscribing
  // (the effect runs once and keeps Monaco's models alive).
  const onLeftChangeRef = useRef(onLeftChange);
  onLeftChangeRef.current = onLeftChange;
  const onRightChangeRef = useRef(onRightChange);
  onRightChangeRef.current = onRightChange;
  // Latest Left/Right text from the parent, read when the models are created so
  // a late seed (buffers restored from storage a tick after mount) is honored,
  // and watched by the sync effects below to push external changes into the
  // live models.
  const initialLeftRef = useRef(initialLeft);
  initialLeftRef.current = initialLeft;
  const initialRightRef = useRef(initialRight);
  initialRightRef.current = initialRight;

  // ── UI state (the text content itself lives in Monaco) ─────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  // Whether the two panes scroll together (default) or independently.
  const [syncScroll, setSyncScroll] = useState(true);
  // CSS-based fullscreen (fixed inset-0) so the app's tokens/dark mode/chrome
  // continue to apply, unlike the native Fullscreen API.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Number of line-change hunks between the two documents (Monaco's own line
  // diff). `null` until the first diff has been computed.
  const [changeCount, setChangeCount] = useState<number | null>(null);
  // Flips true once the Monaco models exist, so buffers restored from storage
  // before Monaco finished loading (a page refresh) are still pushed into the
  // editors once they mount (see the external-sync effects below).
  const [modelsReady, setModelsReady] = useState(false);

  // ── Monaco handles (populated by the async client-only setup) ──────────────
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  // Transient "copied" indicator for the banner copy buttons (per side).
  const [copiedSide, setCopiedSide] = useState<'left' | 'right' | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Copy the current content of one pane's Monaco model to the clipboard. */
  const copySide = (side: 'left' | 'right') => {
    const model = side === 'left' ? originalModelRef.current : modifiedModelRef.current;
    const text = model?.getValue() ?? '';
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedSide(side);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopiedSide(null), 1500);
      })
      .catch(() => {
        /* clipboard unavailable/blocked — leave the content untouched */
      });
  };
  const viewModeRef = useRef<ViewMode>(viewMode);
  viewModeRef.current = viewMode;
  const syncScrollRef = useRef(syncScroll);
  syncScrollRef.current = syncScroll;

  // Mount Monaco (client-only) and wire the line-diff count.
  useEffect(() => {
    if (typeof window === 'undefined') return; // never during SSR
    const container = containerRef.current;
    if (!container) return;

    let monaco: typeof Monaco | null = null;
    let editor: Monaco.editor.IStandaloneDiffEditor | null = null;
    let disposed = false;
    const subscriptions: Monaco.IDisposable[] = [];
    let unsubscribeTheme: (() => void) | null = null;
    // Handle for the in-flight "jump to next difference" scroll animation, so a
    // new click cancels the previous animation and cleanup can stop it.
    let scrollAnimationFrame: number | null = null;

    void (async () => {
      // Plain text needs no language worker — only the base editor worker.
      const { default: EditorWorker } = await import(
        'monaco-editor/esm/vs/editor/editor.worker?worker'
      );
      if (disposed) return;

      (self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment =
        {
          getWorker() {
            return new EditorWorker();
          },
        };

      // Narrow editor import (lean bundle). Register folding so the gutter fold
      // controls work; no language contribution is needed for plain text.
      const editorApi = await import('monaco-editor/esm/vs/editor/editor.api');
      await import('monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js');
      if (disposed) return;
      monaco = editorApi as unknown as typeof Monaco;

      // Token-driven diff colors, with light/dark variants that follow the app
      // theme (shared with the JSON diff editor).
      defineMonacoThemes(monaco);

      editor = monaco.editor.createDiffEditor(container, {
        theme: diffThemeName(),
        renderSideBySide: viewModeRef.current === 'side-by-side',
        // Honor the side-by-side choice at any width (Monaco otherwise collapses
        // to inline below ~900px, making the toggle appear to do nothing).
        useInlineViewWhenSpaceIsLimited: false,
        originalEditable: true, // Left pane is an editable text input.
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
        // Let the wheel chain to the page at a scroll end so long text can be
        // scrolled to the very bottom/top.
        scrollbar: { alwaysConsumeMouseWheel: false },
        renderOverviewRuler: false,
        // Plain text: honor whitespace changes so trailing-space/indent edits
        // still show as differences.
        ignoreTrimWhitespace: false,
        // Wrap long lines so prose/logs stay readable without horizontal scroll.
        wordWrap: 'on',
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        fontSize: 13,
        lineHeight: 20,
      });

      // Plain-text models (no 'json' language ⇒ no tokenizer/validation).
      const original = monaco.editor.createModel(initialLeftRef.current, 'plaintext');
      const modified = monaco.editor.createModel(initialRightRef.current, 'plaintext');
      original.updateOptions({ tabSize: 2 });
      modified.updateOptions({ tabSize: 2 });
      editor.setModel({ original, modified });
      originalModelRef.current = original;
      modifiedModelRef.current = modified;
      editorRef.current = editor;
      // Signal that the models exist so the external-sync effects reconcile the
      // editors against the latest (possibly just-restored) buffers.
      setModelsReady(true);

      // Surface edits to the composing parent so the shared buffers stay in sync.
      subscriptions.push(
        original.onDidChangeContent(() => {
          onLeftChangeRef.current?.(original.getValue());
        }),
      );
      subscriptions.push(
        modified.onDidChangeContent(() => {
          onRightChangeRef.current?.(modified.getValue());
        }),
      );

      // A decorations collection on the modified (right) pane that renders one
      // clickable arrow glyph in the gutter at the first line of every change.
      const modifiedEditor = editor.getModifiedEditor();
      const glyphs = modifiedEditor.createDecorationsCollection([]);

      // Update the difference count AND the gutter arrow glyphs whenever Monaco
      // recomputes the line diff.
      subscriptions.push(
        editor.onDidUpdateDiff(() => {
          if (disposed || !editor || !monaco) return;
          const changes = editor.getLineChanges() ?? [];
          setChangeCount(changes.length);

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

      // How many lines of context to keep above the target, so the difference
      // lands on the 4th visible line (3 lines above it), and how long the
      // scroll animation takes. A longer duration reads as a slower glide.
      const LINES_ABOVE_TARGET = 3;
      const SCROLL_DURATION_MS = 650;

      /**
       * Set the modified pane's scroll offset, bypassing the Sync-Scroll shim.
       * When Sync Scroll is OFF, `setScrollTop` is shadowed with a no-op on the
       * pane (see {@link setDiffScrollSync}); the original native setter is saved
       * under a private key, so we call that when present. When Sync Scroll is
       * ON the setter is native and Monaco mirrors the scroll to the other pane.
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
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / SCROLL_DURATION_MS);
          // easeInOutQuad
          const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
          setPaneScrollTop(pane, from + distance * eased);
          if (t < 1 && !disposed) {
            scrollAnimationFrame = requestAnimationFrame(tick);
          } else {
            scrollAnimationFrame = null;
          }
        };
        scrollAnimationFrame = requestAnimationFrame(tick);
      };

      // Clicking an arrow glyph jumps to the NEXT difference and slowly scrolls
      // it to a fixed spot near the top of the viewport (the 4th line). Doing the
      // scroll ourselves (rather than Monaco's `goToDiff` / `revealLine*`)
      // guarantees the target always lands at the same relative position and
      // lets us control the animation speed.
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
          // Down arrows: jump to the next difference below the clicked arrow
          // (wrapping to the first) and glide it to the 4th visible line.
          const changes = editorRef.current?.getLineChanges() ?? [];
          // The modified-side start line of each change, ascending — the exact
          // lines the arrow glyphs sit on.
          const lines = changes
            .map((change) => Math.max(1, change.modifiedStartLineNumber))
            .sort((a, b) => a - b);
          if (lines.length === 0) return;
          const target = lines.find((line) => line > clickedLine) ?? lines[0];
          modEd.setPosition({ lineNumber: target, column: 1 });
          // Scroll offset that puts `target` on the 4th visible line (three
          // lines of context above it). getTopForLineNumber accounts for wrapped
          // lines; Monaco clamps the value to the valid scroll range.
          const topLine = Math.max(1, target - LINES_ABOVE_TARGET);
          animateScrollTo(modEd, modEd.getTopForLineNumber(topLine));
          modEd.focus();
        }),
      );

      // Apply the current Sync Scroll choice (default synced).
      setDiffScrollSync(editor, syncScrollRef.current);

      // Follow live app theme toggles.
      unsubscribeTheme = onAppThemeChange(() => {
        if (monaco) applyMonacoTheme(monaco, 'diff');
      });
    })();

    return () => {
      disposed = true;
      if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame);
      for (const sub of subscriptions) sub.dispose();
      unsubscribeTheme?.();
      // Dispose the diff editor BEFORE its text models (detaching first) so
      // Monaco does not throw "TextModel got disposed before DiffEditorWidget
      // model got reset" when tools are switched rapidly.
      editorRef.current = null;
      editor?.setModel(null);
      editor?.dispose();
      originalModelRef.current?.dispose();
      modifiedModelRef.current?.dispose();
      originalModelRef.current = null;
      modifiedModelRef.current = null;
    };
  }, []);

  // Apply the view-mode toggle to the live editor.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ renderSideBySide: viewMode === 'side-by-side' });
    // Force a relayout on the next frame so the newly-selected view paints
    // immediately (toggling the mode does not resize the container, so
    // automaticLayout's ResizeObserver never fires).
    const raf = requestAnimationFrame(() => editorRef.current?.layout());
    return () => cancelAnimationFrame(raf);
  }, [viewMode]);

  // Apply the Sync Scroll toggle to the live editor.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    setDiffScrollSync(editor, syncScroll);
  }, [syncScroll]);

  // Fullscreen side effects: lock page scroll while expanded and let Escape
  // collapse it. Also force a relayout on the next frame so the editor paints
  // at the new size immediately.
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

  useEffect(() => {
    const raf = requestAnimationFrame(() => editorRef.current?.layout());
    return () => cancelAnimationFrame(raf);
  }, [isFullscreen]);

  // Keep the live Monaco models in sync with externally-driven text changes
  // (e.g. the Left/Right buffers restored from storage after a page refresh,
  // seeded by the parent, OR the active comparison changing when the user
  // switches tabs). Switching comparisons changes initialLeft/initialRight to
  // the newly-active comparison's text, and these effects reconcile the models
  // to it — the same external-sync path used for restore/seed. Guarded by a
  // value comparison so our own edits — the parent echoes them straight back as
  // new props — never trigger a redundant `setValue` (which would reset the
  // cursor/undo stack or loop).
  useEffect(() => {
    const model = originalModelRef.current;
    if (model && model.getValue() !== initialLeft) model.setValue(initialLeft);
  }, [initialLeft, modelsReady]);
  useEffect(() => {
    const model = modifiedModelRef.current;
    if (model && model.getValue() !== initialRight) model.setValue(initialRight);
  }, [initialRight, modelsReady]);
  // Clear the pending "copied" reset timer on unmount.
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const showCountBanner = changeCount !== null;

  // Sync Scroll is only actionable in the side-by-side layout (unified has a
  // single pane), and only meaningful once the documents actually differ.
  const showSyncScroll = changeCount !== null && changeCount > 0;
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
      data-component="text-compare-panel"
      data-fullscreen={isFullscreen ? 'true' : undefined}
    >
      {/* ── Toolbar: title, difference banner, and view/scroll/fullscreen ──── */}
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-3 py-2 sm:gap-4 sm:px-4">
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <span class="shrink-0 font-sans text-body-sm-strong text-ink">Text Compare</span>
          {comparisons && onAddComparison && (
            <div class="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Comparisons">
              {comparisons.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <div
                    key={c.id}
                    class={`group inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 font-sans text-body-sm transition-colors ${
                      isActive
                        ? 'border-hairline bg-canvas text-ink shadow-level-1'
                        : 'border-transparent bg-canvas-soft-2 text-body hover:bg-canvas-soft hover:text-ink'
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      data-comparison-tab={c.id}
                      class="cursor-pointer whitespace-nowrap bg-transparent focus-visible:outline-none"
                      onClick={() => onSelectComparison?.(c.id)}
                    >
                      {c.name}
                    </button>
                    {comparisons.length > 1 && onCloseComparison && (
                      <button
                        type="button"
                        aria-label={`Close ${c.name}`}
                        title={`Close ${c.name}`}
                        data-comparison-close={c.id}
                        class="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-mute transition-colors hover:bg-error-soft hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseComparison(c.id);
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                data-action="add-comparison"
                title="Open a new comparison"
                // class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-hairline px-2.5 py-1 font-sans text-body-sm text-body transition-colors hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
                class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-[1px] border-[#D4D9E1] px-2.5 py-1 font-sans text-body-sm text-body transition-colors hover:bg-canvas-soft hover:text-ink hover:border-[#A8AFB9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
                onClick={() => onAddComparison()}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                new compare
              </button>
            </div>
          )}
        </div>

        <div class="flex items-center gap-2">
          {/* Sync Scroll toggle — shown only once the documents differ. */}
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

          {/* Clear both texts (and their labels). Parent owns the reset so the
              shared buffers + persisted storage are wiped together. */}
          {onClear && (
            <button
              type="button"
              class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 font-sans text-button-md text-body ring-1 ring-inset ring-hairline transition-colors cursor-pointer hover:bg-canvas-soft hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
              data-action="clear-all"
              title="Clear both texts"
              onClick={onClear}
            >
              Clear
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 4h11" />
                <path d="M6 4V2.75a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75V4" />
                <path d="M4.5 4l.5 8.6a1 1 0 0 0 1 .9h3.9a1 1 0 0 0 1-.9L12 4" />
                <path d="M6.75 6.75v4.25M9.25 6.75v4.25" />
              </svg>
            </button>
          )}

          {/* View toggle: side-by-side vs unified. */}
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
              whole viewport (Escape or click again to exit). Icon-only, matching
              the JSON Diff tool. */}
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

      {/* ── Editable file names + difference count ────────────────────────────
          Three columns keep the count centered regardless of field widths: the
          Left name sits above the left pane, the Right name above the right. */}
      {showCountBanner && (
        <div
          class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-hairline bg-canvas-soft px-4 py-2"
          data-region={changeCount === 0 ? 'no-differences' : 'difference-summary'}
        >
          {onLeftNameChange ? (
            <div class="flex min-w-0 items-center gap-1 justify-self-start">
              <input
                type="text"
                value={leftName}
                onInput={(event) => onLeftNameChange((event.currentTarget as HTMLInputElement).value)}
                placeholder="Original file name"
                aria-label="Left file name"
                data-field="left-name"
                class={`${NAME_FIELD_BASE} w-auto max-w-full [field-sizing:content] text-left`}
              />
              <button
                type="button"
                class={COPY_BTN_BASE}
                data-action="copy-left"
                title="Copy original"
                aria-label="Copy original text"
                onClick={() => copySide('left')}
              >
                {copiedSide === 'left' ? <CheckGlyph /> : <CopyGlyph />}
              </button>
            </div>
          ) : (
            <span />
          )}

          <div
            class="flex items-center justify-center gap-2 justify-self-center"
            role="status"
          >
            {changeCount === 0 ? (
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
                {changeCount} {changeCount === 1 ? 'difference' : 'differences'} found
              </span>
            )}
          </div>

          {onRightNameChange ? (
            <div class="flex min-w-0 items-center gap-1 justify-self-end">
              <button
                type="button"
                class={COPY_BTN_BASE}
                data-action="copy-right"
                title="Copy modified"
                aria-label="Copy modified text"
                onClick={() => copySide('right')}
              >
                {copiedSide === 'right' ? <CheckGlyph /> : <CopyGlyph />}
              </button>
              <input
                type="text"
                value={rightName}
                onInput={(event) => onRightNameChange((event.currentTarget as HTMLInputElement).value)}
                placeholder="Modified file name"
                aria-label="Right file name"
                data-field="right-name"
                class={`${NAME_FIELD_BASE} w-auto max-w-full [field-sizing:content] text-right`}
              />
            </div>
          ) : (
            <span />
          )}
        </div>
      )}

      {/* Monaco diff editor fills the remaining height. */}
      <div ref={containerRef} class="min-h-0 flex-1" data-monaco="text-compare" />
    </div>
  );
}

export default TextComparePanel;
