/** @jsxImportSource preact */
// Feature: json-viewer-free
//
// EditorPane — the Monaco editor wrapper for the Viewer (Req 6.1, 6.4, 6.5, 6.6).
//
// This Preact island mounts a single Monaco editor instance into a container
// and wires it to the shared `$document` store:
//
//   - Monaco is imported ONLY on the client (dynamic `import()` inside an
//     effect, guarded on `typeof window`), so nothing Monaco-related ever runs
//     during SSR.
//   - `self.MonacoEnvironment.getWorker` is configured to build Monaco's
//     editor/json language workers from same-origin worker chunks using Vite's
//     `?worker` pattern, so no worker is loaded cross-origin (privacy, Req 18).
//   - Monaco's OWN JSON schema validation is disabled — our `parseJson`
//     Validator is authoritative. Syntax coloring (tokenization) is preserved.
//   - On every content change the editor debounces 300 ms (Req 6.1), then runs
//     the shared `parseJson` (via `setDocumentText`). On a syntax error it sets
//     a single inline model marker at the first error's 1-based line/column
//     (Req 6.4, 6.5); when the content is valid it clears all markers
//     (Req 6.5, 6.6).
//   - The editor seeds from `$document.text` and stays in sync with external
//     changes (e.g. a share-link load) without feedback loops or needless
//     cursor disruption.
//
// All editor resources, timers, and subscriptions are torn down on unmount.

import { useEffect, useRef } from 'preact/hooks';
import {
  $document,
  setDocumentState,
  setDocumentText,
  setWorkerActivity,
} from '../../lib/stores/document';
import type { ParseResult } from '../../lib/json-core/parse';
import { isLargeDocument } from '../../lib/workers/large-document';
import { JobCancelledError, WorkerClient } from '../../lib/workers/worker-client';
import { markersForParseResult } from './editor-markers';
import type * as Monaco from 'monaco-editor';

/** Debounce window before validation runs after the last keystroke (Req 6.1). */
const VALIDATION_DEBOUNCE_MS = 300;

/** Marker owner string namespacing our validation markers on the model. */
const MARKER_OWNER = 'json-viewer-free';

/** Label for the parse progress/error surfaced to the StatusBar (Req 17.3). */
const PARSE_LABEL = 'Parsing';

/**
 * Parse a Large_Document, dispatching the work and resolving with the result.
 * Injectable for testing; when omitted EditorPane runs a real `WorkerClient`
 * over `parse.worker.ts`.
 */
export type ParseLargeFn = (
  text: string,
  onProgress?: (progress: number) => void,
) => Promise<ParseResult>;

/** Props for {@link EditorPane}. */
export interface EditorPaneProps {
  /**
   * Optional hook giving a parent access to the live editor instance once it
   * has mounted (e.g. to drive format/clear shortcuts). The editor is disposed
   * on unmount, so callers must not retain it past the component's lifetime.
   */
  onEditorReady?: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
  /**
   * Inject a Large_Document parser for testing. When omitted, a real
   * `WorkerClient` over `parse.worker.ts` is created lazily for documents at or
   * above the Large_Document threshold (Req 17.1).
   */
  parseLarge?: ParseLargeFn;
}

/**
 * The Monaco-backed JSON editor pane. Renders a full-height container styled
 * with theme tokens; the Monaco instance is created lazily on the client.
 */
export function EditorPane({ onEditorReady, parseLarge }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest injected parser, read inside the effect without re-subscribing.
  const parseLargeRef = useRef<ParseLargeFn | undefined>(parseLarge);
  parseLargeRef.current = parseLarge;

  useEffect(() => {
    // Never run Monaco during SSR (Req: client-only import).
    if (typeof window === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    // Captured locals for cleanup; the async setup populates them.
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    let monaco: typeof Monaco | null = null;
    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let changeSub: Monaco.IDisposable | null = null;
    let unsubscribe: (() => void) | null = null;
    // Auto-height wiring (grow-to-content): the editor is exactly as tall as its
    // content, capped at a fraction of the viewport. A folded/short document
    // shrinks the editor (no empty canvas); a large one caps the height so
    // Monaco keeps virtualizing its own lines and scrolls internally.
    let sizeSub: Monaco.IDisposable | null = null;
    let resizeObserver: ResizeObserver | null = null;
    // Lazily-created worker client used only to parse Large_Documents off the
    // main thread (Req 17.1). Small documents never construct it.
    let parseClient: WorkerClient | null = null;
    // Guards the content-change listener from reacting to edits we apply
    // ourselves when syncing an external store change into the editor.
    let applyingExternal = false;

    const clearDebounce = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    /**
     * Parse a Large_Document off the main thread: use the injected parser when
     * provided, otherwise dispatch the `parse` op to a lazily-created
     * `WorkerClient` over `parse.worker.ts`. `key: 'parse'` supersedes any
     * in-flight parse so rapid edits don't queue stale work (Req 17.5).
     */
    const parseLargeDocument: ParseLargeFn = (text, onProgress) => {
      const injected = parseLargeRef.current;
      if (injected) return injected(text, onProgress);
      if (!parseClient) {
        const worker = new Worker(
          new URL('../../lib/workers/parse.worker.ts', import.meta.url),
          { type: 'module' },
        );
        parseClient = new WorkerClient(worker);
      }
      return parseClient.run<ParseResult, { text: string }>(
        'parse',
        { text },
        { key: 'parse', onProgress },
      );
    };

    /**
     * Reflect a parse result as Monaco model markers: a single Error marker at
     * the first error's 1-based line/column (Req 6.4, 6.5), or no markers when
     * the content is valid (Req 6.5, 6.6).
     */
    const applyMarkers = (result: ParseResult) => {
      if (!editor || !monaco) return;
      const model = editor.getModel();
      if (!model) return;

      // The pure mapping yields no markers for a valid result (clearing prior
      // highlights, Req 6.6) or a single marker at the first error's 1-based
      // line/column (Req 6.4, 6.5). We only layer Monaco's severity enum on top.
      const markers = markersForParseResult(result).map((marker) => ({
        ...marker,
        severity: monaco!.MarkerSeverity.Error,
      }));
      monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
    };

    /**
     * Run validation for the editor's current content. Small documents parse
     * synchronously on the main thread for snappy feedback; Large_Documents are
     * parsed in a worker so input stays responsive (<100 ms, Req 17.1/17.2),
     * with a progress indicator (Req 17.3) and the tree rendered on completion
     * (Req 17.4). A worker failure restores the prior view and surfaces the
     * reason (Req 17.5).
     */
    const runValidation = () => {
      if (!editor) return;
      const text = editor.getValue();

      // Small document: parse inline and mirror markers immediately.
      if (!isLargeDocument(text)) {
        setWorkerActivity(null);
        setDocumentText(text);
        applyMarkers($document.get().parsed);
        return;
      }

      // Large document: dispatch to a worker, keeping the main thread free.
      setWorkerActivity({ status: 'running', label: PARSE_LABEL, progress: 0 });
      parseLargeDocument(text, (progress) => {
        setWorkerActivity({ status: 'running', label: PARSE_LABEL, progress });
      })
        .then((parsed) => {
          if (disposed) return;
          // The text matches the editor (no cursor disruption); publish the
          // already-parsed result without a second main-thread parse, then
          // mirror its markers (Req 17.4).
          setDocumentState(text, parsed);
          applyMarkers(parsed);
          setWorkerActivity(null);
        })
        .catch((error: unknown) => {
          // A superseded parse (newer edit) is expected; ignore it silently.
          if (disposed || error instanceof JobCancelledError) return;
          // Failure: retain the prior parsed view (the store is untouched) and
          // surface the reason (Req 17.5).
          setWorkerActivity({
            status: 'error',
            label: PARSE_LABEL,
            message:
              error instanceof Error && error.message
                ? error.message
                : 'Parsing the document failed unexpectedly.',
          });
        });
    };

    void (async () => {
      // Configure Monaco's worker environment from same-origin worker chunks
      // (Vite `?worker` pattern). Done before creating the editor so language
      // services pick up the workers.
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

      // Import the editor narrowly (just the editor API) plus the JSON
      // language contribution, rather than the full `monaco-editor` barrel, to
      // keep the bundle lean and meet the interactive budget (design: Monaco
      // Integration, Req 22.7). The JSON contribution registers the `json`
      // language and populates `monaco.languages.json`.
      const editorApi = await import(
        'monaco-editor/esm/vs/editor/editor.api'
      );
      await import('monaco-editor/esm/vs/language/json/monaco.contribution');
      // The lean `editor.api` entry omits editor feature contributions, so
      // folding controls would never render. Register the folding contribution
      // explicitly (keeps the bundle far lighter than importing `editor.main`)
      // so the gutter collapse/expand chevrons work (user-requested folding).
      await import('monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js');
      // The fold chevrons (and every Monaco UI icon) are glyphs in the codicon
      // icon font. The lean entry does not inject the codicon @font-face, so the
      // icons render as missing-glyph boxes. Importing `codiconStyles` injects
      // the font-face + icon classes (the .ttf is emitted same-origin, allowed
      // by the `font-src 'self'` CSP).
      await import('monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js');
      if (disposed) return;
      monaco = editorApi as unknown as typeof Monaco;

      // Our Validator is authoritative — disable Monaco's own JSON schema
      // diagnostics. Tokenization/syntax coloring is unaffected.
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        validate: false,
        allowComments: false,
        schemaValidation: 'ignore',
        enableSchemaRequest: false,
      });

      editor = monaco.editor.create(container, {
        value: $document.get().text,
        language: 'json',
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        fontSize: 13,
        lineHeight: 20,
        tabSize: 2,
        renderLineHighlight: 'line',
        // Code folding: show collapse/expand controls in the gutter beside the
        // line numbers so any JSON object/array can be folded. `'always'` keeps
        // the chevrons visible (not only on hover); folding regions are derived
        // from the JSON brace structure.
        folding: true,
        foldingStrategy: 'auto',
        foldingHighlight: true,
        showFoldingControls: 'always',
        // Let the page scroll when the editor reaches its top/bottom: don't
        // let Monaco swallow the wheel at its scroll boundaries, so wheel
        // events chain to the page (matching the tree pane's behavior).
        scrollbar: {
          alwaysConsumeMouseWheel: false,
        },
      });

      onEditorReady?.(editor);

      // Grow-to-content height: size the editor to its content, capped at ~85%
      // of the viewport. The host width tracks the pane (ResizeObserver); the
      // height tracks the content (onDidContentSizeChange). Below the cap the
      // editor shrinks to fit (no empty canvas, page scrolls); above it the
      // height is capped and Monaco virtualizes/scrolls its own lines.
      const host = container;
      const heightCap = () =>
        Math.max(160, Math.floor((window.innerHeight || 800) * 0.85));
      const relayout = () => {
        if (!editor) return;
        const width = host.clientWidth || host.getBoundingClientRect().width;
        const contentH = editor.getContentHeight();
        const height = Math.min(contentH, heightCap());
        host.style.height = `${height}px`;
        editor.layout({ width, height });
      };
      if (typeof ResizeObserver !== 'undefined' && host.parentElement) {
        // Observe the parent for width changes (divider drag, window resize).
        // We must NOT observe the host itself, since relayout sets the host's
        // height and that would re-trigger the observer in a loop.
        resizeObserver = new ResizeObserver(() => relayout());
        resizeObserver.observe(host.parentElement);
      }
      sizeSub = editor.onDidContentSizeChange(() => relayout());
      relayout();

      // Debounced validation on every content change (Req 6.1). Skip changes
      // we apply ourselves during external sync to avoid feedback loops.
      changeSub = editor.onDidChangeModelContent(() => {
        if (applyingExternal) return;
        clearDebounce();
        debounceTimer = setTimeout(runValidation, VALIDATION_DEBOUNCE_MS);
      });

      // Seed the store + markers for the initial content.
      runValidation();

      // Keep the editor in sync with external store changes (e.g. share-link
      // load). The subscriber fires immediately with the current value; that
      // first call is a no-op because the text already matches. We also skip
      // whenever the store text already equals the editor value, which is the
      // case for our own edits, preventing a write-back loop or cursor jump.
      unsubscribe = $document.subscribe((state) => {
        if (!editor) return;
        if (state.text === editor.getValue()) return;

        const model = editor.getModel();
        if (!model) return;

        applyingExternal = true;
        // Replace the full content via an edit so undo history and cursor are
        // handled gracefully rather than wiped by setValue.
        editor.executeEdits('external-sync', [
          { range: model.getFullModelRange(), text: state.text },
        ]);
        editor.pushUndoStop();
        applyingExternal = false;

        // The store already holds the parsed result for this text; reflect it.
        applyMarkers(state.parsed);
      });
    })();

    return () => {
      disposed = true;
      clearDebounce();
      changeSub?.dispose();
      sizeSub?.dispose();
      resizeObserver?.disconnect();
      unsubscribe?.();
      parseClient?.dispose(true);
      parseClient = null;
      editor?.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      class="w-full overflow-hidden bg-canvas font-mono text-code"
    />
  );
}

export default EditorPane;
