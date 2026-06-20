/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 16.3
//
// QueryPanel — the Query tool's JSONPath / JMESPath expression evaluator
// (Req 16.3–16.7).
//
// It evaluates an expression (in the selected mode) against the shared JSON
// document by dispatching the `query` op to `query.worker.ts` through the shared
// `WorkerClient`, so even a 50 MB document is evaluated off the main thread and
// the UI stays responsive (Req 16.1/16.2, 17.1).
//
// Behavior mapped to requirements:
//   • Mode selection — JSONPath or JMESPath select which language the
//     expression is written in; the chosen mode is forwarded to the engine.
//   • Results — a successful evaluation renders the complete match set as
//     pretty-printed JSON.
//   • No-results indicator (Req 16.4) — when the evaluation succeeds with zero
//     matches, a clear "no results" indicator is shown instead of output.
//   • Invalid / empty expression (Req 16.3, 16.6) — the engine returns a typed
//     error with a human-readable reason and, where available, the 0-based
//     character position of the syntax problem. That error is surfaced and the
//     PREVIOUSLY displayed results are left unchanged.
//   • Copy (Req 16.5, 16.7) — a control copies the complete result set to the
//     clipboard; a visible confirmation is shown on success, and a copy-failed
//     error is shown (while the results are retained) on failure.
//
// The JSON side is bound to the shared `$document` store so the document flows
// between the Viewer, Grid, Converter, and Query tools (Req 21.5/21.6).
//
// The worker is created lazily and disposed on unmount. For testability the
// query runner is injectable via the `query` prop, so tests can exercise the
// panel without a real `Worker` (which Vite builds from `import.meta.url`).

import { useStore } from '@nanostores/preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { $document } from '../../lib/stores/document';
import type { QueryError, QueryMode, QueryResult } from '../../lib/query/engine';
import {
  JobCancelledError,
  WorkerClient,
} from '../../lib/workers/worker-client';

/** Serializable inputs for the `query` worker op. */
export interface QueryPayload {
  /** The JSON document text to query. */
  text: string;
  /** The query expression. */
  expression: string;
  /** Which query language the expression is written in. */
  mode: QueryMode;
}

/** A query runner: dispatches a job and resolves with its typed result. */
export type QueryFn = (
  payload: QueryPayload,
  onProgress?: (progress: number) => void,
) => Promise<QueryResult>;

/** Props for {@link QueryPanel}. */
export interface QueryPanelProps {
  /**
   * Inject a query runner for testing. When omitted, a real `WorkerClient` over
   * `query.worker.ts` is created lazily and used.
   */
  query?: QueryFn;
}

/** Display metadata for each query mode. */
const MODES: ReadonlyArray<{ id: QueryMode; label: string }> = [
  { id: 'jsonpath', label: 'JSONPath' },
  { id: 'jmespath', label: 'JMESPath' },
] as const;

/** Lifecycle of a single evaluation attempt. */
type Status = 'idle' | 'running' | 'results' | 'empty' | 'error';

/** Pretty-print the result set as the displayable / copyable text. */
function formatResults(results: unknown[]): string {
  return JSON.stringify(results, null, 2);
}

/**
 * The Query panel. Selects a mode, evaluates the expression against the shared
 * document in a worker, and renders the match set, a no-results indicator, or a
 * located error — leaving previously displayed results unchanged on error.
 */
export default function QueryPanel({ query }: QueryPanelProps) {
  const doc = useStore($document);

  const [mode, setMode] = useState<QueryMode>('jsonpath');
  const [expression, setExpression] = useState('');

  // The text of the currently displayed result set (pretty-printed JSON). Kept
  // separate from `status` so an error leaves the prior results in place
  // (Req 16.3, 16.6).
  const [resultsText, setResultsText] = useState('');
  const [error, setError] = useState<QueryError | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // ── Worker client (lazy, disposed on unmount) ───────────────────────────
  const clientRef = useRef<WorkerClient | null>(null);
  useEffect(() => {
    return () => {
      clientRef.current?.dispose(true);
      clientRef.current = null;
    };
  }, []);

  const runQuery = useCallback<QueryFn>(
    (payload, onProgress) => {
      if (query) return query(payload, onProgress);
      if (!clientRef.current) {
        const worker = new Worker(
          new URL('../../lib/workers/query.worker.ts', import.meta.url),
          { type: 'module' },
        );
        clientRef.current = new WorkerClient(worker);
      }
      // `key: 'query'` supersedes any in-flight evaluation so rapid re-runs
      // don't queue stale work (Req 17.5).
      return clientRef.current.run<QueryResult, QueryPayload>('query', payload, {
        key: 'query',
        onProgress,
      });
    },
    [query],
  );

  // ── Evaluate on explicit submit (Run / Enter) ───────────────────────────
  const evaluate = useCallback(() => {
    setCopyState('idle');
    setStatus('running');

    runQuery({ text: doc.text, expression, mode })
      .then((result) => {
        if (result.ok) {
          // Success: render the complete match set, or the no-results
          // indicator when the evaluation matched nothing (Req 16.4).
          setError(null);
          if (result.results.length === 0) {
            setResultsText('');
            setStatus('empty');
          } else {
            setResultsText(formatResults(result.results));
            setStatus('results');
          }
        } else {
          // Failure (invalid or empty expression): surface the located error
          // and leave the previously displayed results unchanged (Req 16.3,
          // 16.6).
          setError(result.error);
          setStatus('error');
        }
      })
      .catch((err: unknown) => {
        // A superseded/cancelled job is expected during rapid re-runs; ignore.
        if (err instanceof JobCancelledError) return;
        setError({
          message:
            err instanceof Error && err.message
              ? err.message
              : 'The query failed unexpectedly.',
        });
        setStatus('error');
      });
  }, [doc.text, expression, mode, runQuery]);

  const onSubmit = (event: Event) => {
    event.preventDefault();
    evaluate();
  };

  const onCopy = async () => {
    if (status !== 'results' || resultsText === '') return;
    try {
      await navigator.clipboard.writeText(resultsText);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // Copy failed: surface an error and retain the displayed results (Req 16.7).
      setCopyState('failed');
    }
  };

  const modeLabel = MODES.find((m) => m.id === mode)!.label;

  return (
    <section aria-label="Query panel" data-tool-panel="query" class="flex flex-col gap-md">
      {/* ── Controls ─────────────────────────────────────────────────── */}
      <form class="flex flex-col gap-sm" onSubmit={onSubmit}>
        <div class="flex flex-wrap items-center gap-md">
          <div role="group" aria-label="Query mode" class="flex items-center gap-xxs">
            {MODES.map((m) => {
              const selected = m.id === mode;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={selected}
                  class={
                    'rounded-xs px-sm py-xxs text-button-md ring-1 ring-inset ' +
                    (selected
                      ? 'bg-primary text-on-primary ring-primary'
                      : 'text-body ring-hairline hover:bg-canvas-soft')
                  }
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <span class="ml-auto text-caption text-mute" aria-live="polite">
            {status === 'running' ? 'Evaluating…' : ''}
          </span>
        </div>

        <div class="flex items-center gap-xs">
          <label class="sr-only" for="query-expression">
            {`${modeLabel} expression`}
          </label>
          <input
            id="query-expression"
            type="text"
            spellcheck={false}
            autocomplete="off"
            aria-label={`${modeLabel} expression`}
            class="min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-sm py-xs font-mono text-code text-ink"
            value={expression}
            onInput={(e) => setExpression((e.target as HTMLInputElement).value)}
            placeholder={
              mode === 'jsonpath' ? '$.store.book[*].title' : 'store.book[*].title'
            }
          />
          <button
            type="submit"
            class="rounded-xs bg-primary px-md py-xs text-button-md text-on-primary ring-1 ring-inset ring-primary hover:opacity-90"
          >
            Run
          </button>
        </div>
      </form>

      {/* ── Results / no-results / error ─────────────────────────────── */}
      <div class="flex min-h-0 flex-col gap-xs">
        <div class="flex items-center gap-xs">
          <label class="text-body-sm-strong text-ink" for="query-results">
            Results
          </label>
          <div class="ml-auto flex items-center gap-xs">
            {status === 'results' && resultsText !== '' ? (
              <button
                type="button"
                class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
                onClick={onCopy}
              >
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </button>
            ) : null}
          </div>
        </div>

        {/* Copy confirmation / failure (Req 16.5, 16.7). */}
        {copyState === 'copied' ? (
          <p role="status" aria-live="polite" class="text-caption text-success-deep">
            Results copied to the clipboard.
          </p>
        ) : null}
        {copyState === 'failed' ? (
          <p role="alert" class="text-caption text-error-deep">
            Copy did not complete. The results are still shown below.
          </p>
        ) : null}

        {status === 'error' && error ? (
          <div
            role="alert"
            class="min-h-[280px] w-full overflow-auto rounded-sm border border-error bg-error-soft p-sm"
          >
            <p class="text-body-sm-strong text-error-deep">Query failed</p>
            <p class="mt-xs text-body-sm text-error-deep">{error.message}</p>
            {error.position !== undefined ? (
              <p class="mt-xs text-caption text-error-deep">
                {`Character position ${error.position}`}
              </p>
            ) : null}
            <p class="mt-sm text-caption text-mute">Previous results are unchanged.</p>
          </div>
        ) : status === 'empty' ? (
          <div
            role="status"
            aria-live="polite"
            class="flex min-h-[280px] w-full items-center justify-center rounded-sm border border-divider bg-canvas-soft p-sm text-body-sm text-mute"
          >
            No results. The expression matched nothing in the document.
          </div>
        ) : (
          <textarea
            id="query-results"
            readOnly
            aria-label="Query results"
            class="min-h-[280px] w-full resize-y rounded-sm border border-divider bg-canvas-soft p-sm font-mono text-code text-body"
            value={resultsText}
            placeholder="Enter an expression and run it to see matching results."
          />
        )}
      </div>
    </section>
  );
}
