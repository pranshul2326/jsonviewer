/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 14.2
//
// SemanticDiffList — the Diff Checker's path-keyed structural difference list
// (Req 8.1, 8.8).
//
// Where `DiffPanel` renders the line-oriented Monaco diff, this island renders
// the *semantic* diff produced by `json-core/diff.ts#semanticDiff`: a flat list
// of `Difference` entries, each identifying a JSON path (RFC 6901 pointer) and
// classified as exactly one of addition / deletion / modification (Req 8.1).
// Because the diff is built on canonicalization, key reordering and whitespace
// changes produce no entries.
//
// Behavior mapped to requirements:
//   • Req 8.1 — every entry shows its path and its classification, with a
//     token-driven, visually distinct style per kind:
//       - addition     → cyan/green (value present only in Right),
//       - deletion      → red       (value present only in Left),
//       - modification  → amber     (value differs on both sides).
//     The three styles differ in border, badge color, and label so they can
//     never be confused.
//   • Req 8.8 — when either document is invalid JSON, the validation error
//     state defined in Requirement 6 (error description + 1-based line:column)
//     is shown for the invalid document instead of the list. This mirrors the
//     shared validation-error presenter used across the Diff/Merge tools.
//
// The component is pure/presentational: the parse + diff decision lives in
// `semantic-diff-list-state.ts` so it is unit-testable without a DOM, exactly
// as `diff-view-state.ts` sits beside `DiffPanel`. All styling is token-driven
// (theme.css) — no hardcoded colors.

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { DiffKind, Difference } from '../../lib/json-core/diff';
import { isAnyLarge } from '../../lib/workers/large-document';
import { JobCancelledError } from '../../lib/workers/worker-client';
import { useLazyWorkerClient } from '../../lib/workers/use-worker-client';
import {
  computeSemanticDiffView,
  type DiffDocError,
  type SemanticDiffComputation,
} from './semantic-diff-list-state';

/** Props for {@link SemanticDiffList}. */
export interface SemanticDiffListProps {
  /** Left (original) document text. */
  leftText?: string;
  /** Right (modified) document text. */
  rightText?: string;
}

/** Presentation metadata for each difference kind (Req 8.1, distinct styles). */
const KIND_STYLE: Record<
  DiffKind,
  { label: string; row: string; badge: string }
> = {
  addition: {
    label: 'Added',
    row: 'border-l-cyan-deep bg-cyan-soft/30',
    badge: 'bg-cyan-soft text-cyan-deep',
  },
  deletion: {
    label: 'Removed',
    row: 'border-l-error bg-error-soft/40',
    badge: 'bg-error-soft text-error-deep',
  },
  modification: {
    label: 'Modified',
    row: 'border-l-warning bg-warning-soft/40',
    badge: 'bg-warning-soft text-warning-deep',
  },
};

/** Render a single value carrier as compact JSON, or a marker when absent. */
function renderValue(present: boolean, value: unknown): string {
  return present ? JSON.stringify(value) : '(absent)';
}

/**
 * The validation error state for one document (Req 8.8 → Req 6.4): the error
 * description together with the first error's 1-based line:column. Mirrors the
 * shared presenter used by StatusBar / MergePanel.
 */
function ValidationError({ error }: { error: DiffDocError }) {
  return (
    <p
      class="inline-flex items-center gap-1.5 font-sans text-body-sm text-error"
      data-status="error"
      data-error-side={error.side}
      role="status"
      title={error.message}
    >
      <svg
        width="14"
        height="14"
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
      <span class="max-w-[48ch] truncate">{error.message}</span>
      <span class="font-mono text-caption-mono text-error-deep">
        {error.line}:{error.column}
      </span>
    </p>
  );
}

/** A single path-keyed difference row (Req 8.1). */
function DifferenceRow({ difference }: { difference: Difference }) {
  const style = KIND_STYLE[difference.kind];
  const hasLeft = 'left' in difference;
  const hasRight = 'right' in difference;

  return (
    <li
      class={`flex flex-col gap-1.5 border-l-4 ${style.row} rounded-sm px-3 py-2`}
      data-kind={difference.kind}
      data-path={difference.path}
    >
      <div class="flex items-center gap-2">
        <span
          class={`inline-flex shrink-0 items-center rounded-xs px-1.5 py-0.5 font-sans text-caption ${style.badge}`}
          data-badge={difference.kind}
        >
          {style.label}
        </span>
        <code class="min-w-0 break-all font-mono text-caption-mono text-ink" data-path-label>
          {difference.path === '' ? '(root)' : difference.path}
        </code>
      </div>

      {/* Value carriers per classification (Req 8.4/8.5/8.6). */}
      <div class="flex flex-col gap-0.5 pl-1">
        {hasLeft && (
          <div class="flex min-w-0 items-baseline gap-1.5" data-value="left">
            <span class="shrink-0 font-sans text-caption text-mute">left</span>
            <code class="min-w-0 break-all font-mono text-caption-mono text-body">
              {renderValue(hasLeft, difference.left)}
            </code>
          </div>
        )}
        {hasRight && (
          <div class="flex min-w-0 items-baseline gap-1.5" data-value="right">
            <span class="shrink-0 font-sans text-caption text-mute">right</span>
            <code class="min-w-0 break-all font-mono text-caption-mono text-body">
              {renderValue(hasRight, difference.right)}
            </code>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The semantic diff list. Parses both documents and renders either the
 * validation error state for any invalid document (Req 8.8) or the path-keyed,
 * classified difference list (Req 8.1).
 *
 * Small documents are diffed synchronously on the main thread for snappy
 * feedback. When either document is a Large_Document (≥ 5 MB) the diff is
 * computed in a Web Worker so the UI stays responsive (Req 17.1/17.2): a
 * progress indicator shows while it runs (Req 17.3), the list renders on
 * completion (Req 17.4), and on failure the previously displayed list is
 * retained with the reason shown (Req 17.5).
 */
export function SemanticDiffList({
  leftText = '',
  rightText = '',
}: SemanticDiffListProps) {
  // Small inputs diff inline; large inputs route through the worker.
  const small = !isAnyLarge(leftText, rightText);

  const syncView = useMemo(
    () => (small ? computeSemanticDiffView(leftText, rightText) : null),
    [small, leftText, rightText],
  );

  // ── Large-document worker path ───────────────────────────────────────────
  const [asyncDiffs, setAsyncDiffs] = useState<Difference[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);

  const runDiff = useLazyWorkerClient(
    () =>
      new Worker(new URL('../../lib/workers/diff.worker.ts', import.meta.url), {
        type: 'module',
      }),
  );

  useEffect(() => {
    if (small) {
      // Synchronous path: clear any worker activity from a prior large input.
      setProgress(null);
      setWorkerError(null);
      return;
    }

    let cancelled = false;
    setProgress(0);
    setWorkerError(null);

    runDiff<Difference[], { left: string; right: string }>(
      'diff',
      { left: leftText, right: rightText },
      {
        key: 'diff',
        onProgress: (value) => {
          if (!cancelled) setProgress(value);
        },
      },
    )
      .then((differences) => {
        if (cancelled) return;
        setAsyncDiffs(differences); // render on completion (Req 17.4)
        setProgress(null);
      })
      .catch((err: unknown) => {
        // A superseded comparison (newer edit) is expected; ignore it.
        if (cancelled || err instanceof JobCancelledError) return;
        // Failure: retain the prior list and surface the reason (Req 17.5).
        setProgress(null);
        setWorkerError(
          err instanceof Error && err.message
            ? err.message
            : 'The comparison failed unexpectedly.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [small, leftText, rightText, runDiff]);

  // The unified view to render: the synchronous computation for small inputs,
  // or the worker-produced differences for large inputs.
  const view: SemanticDiffComputation | null = small
    ? syncView
    : asyncDiffs !== null
      ? { errors: [], bothValid: true, differences: asyncDiffs }
      : null;

  const showProgress = !small && progress !== null;

  return (
    <div
      class="flex h-full flex-col gap-3 overflow-auto bg-canvas-soft p-4"
      data-component="semantic-diff-list"
    >
      <h2 class="font-sans text-body-md-strong text-ink">Semantic diff</h2>

      {/* Worker progress indicator for a Large_Document diff (Req 17.3). */}
      {showProgress ? (
        <p
          class="font-sans text-caption text-mute"
          role="status"
          aria-live="polite"
          data-region="diff-progress"
        >
          Comparing large documents… {Math.round((progress ?? 0) * 100)}%
        </p>
      ) : null}

      {/* Worker failure reason; the prior list (if any) is retained (Req 17.5). */}
      {workerError ? (
        <p
          class="font-sans text-body-sm text-error"
          role="alert"
          data-region="diff-worker-error"
        >
          Comparison failed: {workerError}
        </p>
      ) : null}

      {/* Validation error state for any invalid document (Req 8.8). */}
      {view !== null && !view.bothValid ? (
        <div
          class="flex flex-col gap-1.5 rounded-sm border border-error/30 bg-error-soft/40 px-3 py-2.5"
          role="alert"
          data-region="diff-errors"
        >
          {view.errors.map((error) => (
            <ValidationError key={error.side} error={error} />
          ))}
        </div>
      ) : view !== null && view.differences && view.differences.length > 0 ? (
        <ul class="flex flex-col gap-2" data-region="difference-list">
          {view.differences.map((difference) => (
            <DifferenceRow
              key={`${difference.kind}:${difference.path}`}
              difference={difference}
            />
          ))}
        </ul>
      ) : view !== null ? (
        <p
          class="font-sans text-body-sm text-body"
          role="status"
          data-region="no-differences"
        >
          No structural differences found.
        </p>
      ) : null}
    </div>
  );
}

export default SemanticDiffList;
