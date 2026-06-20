/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 14.4
//
// MergePanel — the three-way merge UI island (Req 11.5–11.9).
//
// The panel takes three independent JSON documents — a common Base plus a Left
// and a Right derivative — as free-text inputs, and drives the pure
// `threeWayMerge` / `resolveConflict` core (`json-core/merge.ts`):
//
//   • Each input is parsed with the shared `parseJson`. An invalid document
//     surfaces the validation error state defined in Req 6 (error description
//     with 1-based line:column) directly beneath its input (Req 11.9).
//
//   • Once Base, Left, and Right all parse to a model, the merge is computed.
//     Conflicts (Req 11.5) are listed by JSON_Path, each presenting the Base,
//     Left, and Right values, with controls to resolve the conflict by choosing
//     a side (Req 11.6). Resolving applies the chosen value and clears the mark.
//
//   • Export of the merged document is gated on zero unresolved conflicts: while
//     any remain the panel shows the unresolved-conflict count and blocks export
//     (Req 11.7); when none remain it produces the merged document for export
//     (Req 11.8).
//
// All styling is token-driven (design.css), and the panel is self-contained:
// it owns its three inputs rather than reading the shared `$document` store,
// because a merge reconciles three distinct documents at once.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseJson, type ParseResult } from '../../lib/json-core/parse';
import { format } from '../../lib/json-core/serialize';
import {
  threeWayMerge,
  resolveConflict,
  type Conflict,
  type ConflictSide,
  type MergeResult,
} from '../../lib/json-core/merge';
import type { JsonNode } from '../../lib/json-core/types';
import { isAnyLarge } from '../../lib/workers/large-document';
import { JobCancelledError } from '../../lib/workers/worker-client';
import { useLazyWorkerClient } from '../../lib/workers/use-worker-client';

/** The three roles a document plays in a three-way merge. */
type Role = 'base' | 'left' | 'right';

/** Human label for each role. */
const ROLE_LABEL: Record<Role, string> = {
  base: 'Base',
  left: 'Left',
  right: 'Right',
};

/** Default indentation for the exported merged document (2 spaces, Req 5.1). */
const EXPORT_INDENT = { kind: 'space', size: 2 } as const;

/**
 * A valid-empty parse result used to stand in for a Large_Document input on the
 * main thread. Large inputs are parsed/validated in the worker (Req 17.1), so
 * the panel never parses their multi-megabyte text inline; this keeps the
 * per-input validation surface neutral (no false error border) while the
 * worker's outcome drives the real feedback.
 */
const LARGE_INPUT_PLACEHOLDER: ParseResult = {
  ok: true,
  empty: true,
  model: null,
};

/**
 * The usable model from a parse result, or `null` when the input is invalid or
 * empty/whitespace-only (the valid-empty state carries no model).
 */
function modelOf(parsed: ParseResult): JsonNode | null {
  return parsed.ok && !parsed.empty ? parsed.model : null;
}

/** Render a conflict carrier value as pretty JSON, or a marker when absent. */
function formatCarrier(present: boolean, value: unknown): string {
  return present ? JSON.stringify(value, null, 2) : '(absent)';
}

/**
 * The validation error state for a single merge input (Req 11.9 → Req 6.4):
 * the error description together with the first error's 1-based line:column.
 * Renders nothing when the document is valid (including valid-empty).
 */
function ValidationError({ role, parsed }: { role: Role; parsed: ParseResult }) {
  if (parsed.ok) return null;
  const { message, line, column } = parsed.error;
  return (
    <p
      class="mt-1.5 inline-flex items-center gap-1.5 font-sans text-caption text-error"
      data-status="error"
      data-role={role}
      role="status"
      aria-label={`Invalid ${ROLE_LABEL[role]} document: ${message}`}
      title={message}
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
      <span class="max-w-[40ch] truncate">{message}</span>
      <span class="font-mono text-caption-mono text-error-deep">
        {line}:{column}
      </span>
    </p>
  );
}

/** One labeled document input plus its inline validation error state. */
function DocumentInput({
  role,
  value,
  parsed,
  onInput,
}: {
  role: Role;
  value: string;
  parsed: ParseResult;
  onInput: (text: string) => void;
}) {
  const invalid = !parsed.ok;
  return (
    <div class="flex min-w-0 flex-col" data-input={role}>
      <label
        class="mb-1.5 font-sans text-body-sm-strong text-ink"
        for={`merge-input-${role}`}
      >
        {ROLE_LABEL[role]}
      </label>
      <textarea
        id={`merge-input-${role}`}
        class="h-48 w-full resize-y rounded-sm border border-hairline bg-canvas p-2 font-mono text-code text-ink outline-none focus:border-hairline-strong"
        style={
          invalid ? { borderColor: 'var(--color-error)' } : undefined
        }
        spellcheck={false}
        aria-invalid={invalid}
        placeholder={`${ROLE_LABEL[role]} JSON…`}
        value={value}
        onInput={(event) =>
          onInput((event.currentTarget as HTMLTextAreaElement).value)
        }
      />
      <ValidationError role={role} parsed={parsed} />
    </div>
  );
}

/** A single conflict row: Base/Left/Right values + side-resolution controls. */
function ConflictRow({
  conflict,
  onResolve,
}: {
  conflict: Conflict;
  onResolve: (path: string, side: ConflictSide) => void;
}) {
  const sides: { side: ConflictSide; present: boolean; value: unknown }[] = [
    { side: 'base', present: 'base' in conflict, value: conflict.base },
    { side: 'left', present: 'left' in conflict, value: conflict.left },
    { side: 'right', present: 'right' in conflict, value: conflict.right },
  ];

  return (
    <li
      class="rounded-sm border border-hairline bg-canvas p-3"
      data-conflict-path={conflict.path}
    >
      <p class="mb-2 font-mono text-caption-mono text-body">
        <span class="text-mute">path </span>
        <span class="text-ink">{conflict.path === '' ? '(root)' : conflict.path}</span>
      </p>
      <div class="grid gap-2 sm:grid-cols-3">
        {sides.map(({ side, present, value }) => (
          <div
            key={side}
            class="flex min-w-0 flex-col rounded-xs border border-divider bg-canvas-soft p-2"
            data-side={side}
          >
            <span class="mb-1 font-sans text-caption text-mute">
              {ROLE_LABEL[side]}
            </span>
            <pre class="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-caption-mono text-ink">
              {formatCarrier(present, value)}
            </pre>
            <button
              type="button"
              class="mt-auto rounded-sm bg-primary px-2 py-1 font-sans text-button-md text-on-primary"
              data-resolve={side}
              onClick={() => onResolve(conflict.path, side)}
            >
              Use {ROLE_LABEL[side]}
            </button>
          </div>
        ))}
      </div>
    </li>
  );
}

/**
 * The three-way merge panel. Owns the Base/Left/Right inputs, computes the
 * merge whenever all three documents are valid, lists and resolves conflicts,
 * and gates the merged-document export on a zero unresolved-conflict count.
 */
export function MergePanel() {
  const [baseText, setBaseText] = useState('');
  const [leftText, setLeftText] = useState('');
  const [rightText, setRightText] = useState('');

  // Any input ≥ 5 MB routes the merge through the worker (Req 17.1).
  const large = isAnyLarge(baseText, leftText, rightText);

  // Parse each input once per change for small inputs; large inputs are not
  // parsed on the main thread (the worker parses them), so a neutral
  // valid-empty placeholder is used for their validation surface.
  const baseParsed = useMemo(
    () => (large ? LARGE_INPUT_PLACEHOLDER : parseJson(baseText)),
    [large, baseText],
  );
  const leftParsed = useMemo(
    () => (large ? LARGE_INPUT_PLACEHOLDER : parseJson(leftText)),
    [large, leftText],
  );
  const rightParsed = useMemo(
    () => (large ? LARGE_INPUT_PLACEHOLDER : parseJson(rightText)),
    [large, rightText],
  );

  const baseModel = useMemo(() => modelOf(baseParsed), [baseParsed]);
  const leftModel = useMemo(() => modelOf(leftParsed), [leftParsed]);
  const rightModel = useMemo(() => modelOf(rightParsed), [rightParsed]);

  // Small-input readiness: all three documents parse to a model on the main
  // thread.
  const smallReady =
    !large && baseModel !== null && leftModel !== null && rightModel !== null;

  // The live merge result (model-based). For small inputs it is computed
  // synchronously; for large inputs it is created lazily on the first conflict
  // resolution (see `handleResolve`).
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);

  // The worker-computed result for a Large_Document merge: the merged document
  // text (already 2-space formatted) plus the open conflicts.
  const [largeResult, setLargeResult] = useState<{
    mergedText: string;
    conflicts: Conflict[];
  } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);

  // Models for large-path resolution, parsed lazily on the first resolve and
  // invalidated whenever any input changes.
  const largeModelsRef = useRef<{
    base: JsonNode;
    left: JsonNode;
    right: JsonNode;
  } | null>(null);
  useEffect(() => {
    largeModelsRef.current = null;
  }, [baseText, leftText, rightText]);

  // Small path: recompute the merge whenever any model changes.
  useEffect(() => {
    if (large) return;
    if (baseModel && leftModel && rightModel) {
      setMergeResult(threeWayMerge(baseModel, leftModel, rightModel));
    } else {
      setMergeResult(null);
    }
  }, [large, baseModel, leftModel, rightModel]);

  // Large path: dispatch the merge to the worker (off the main thread).
  const runMerge = useLazyWorkerClient(
    () =>
      new Worker(new URL('../../lib/workers/diff.worker.ts', import.meta.url), {
        type: 'module',
      }),
  );

  useEffect(() => {
    if (!large) {
      setLargeResult(null);
      setProgress(null);
      setWorkerError(null);
      return;
    }

    let cancelled = false;
    setProgress(0);
    setWorkerError(null);
    setMergeResult(null);

    runMerge<
      { merged: string; conflicts: Conflict[] },
      { base: string; left: string; right: string }
    >(
      'merge',
      { base: baseText, left: leftText, right: rightText },
      {
        key: 'merge',
        onProgress: (value) => {
          if (!cancelled) setProgress(value);
        },
      },
    )
      .then((result) => {
        if (cancelled) return;
        setLargeResult({ mergedText: result.merged, conflicts: result.conflicts });
        setProgress(null);
      })
      .catch((err: unknown) => {
        // A superseded merge (newer edit) is expected; ignore it.
        if (cancelled || err instanceof JobCancelledError) return;
        // Failure (e.g. an unparsable side): surface the reason; the prior
        // result is retained (Req 11.9 reason, Req 17.5).
        setProgress(null);
        setWorkerError(
          err instanceof Error && err.message
            ? err.message
            : 'The merge failed unexpectedly.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [large, baseText, leftText, rightText, runMerge]);

  const handleResolve = (path: string, side: ConflictSide) => {
    // Small path: resolve directly against the main-thread models (Req 11.6).
    if (!large) {
      if (!mergeResult || !baseModel || !leftModel || !rightModel) return;
      setMergeResult(
        resolveConflict(mergeResult, path, side, baseModel, leftModel, rightModel),
      );
      return;
    }

    // Large path: resolution needs models. Parse them lazily (once) for this
    // explicit, user-initiated action, then resolve on the model-based result.
    let models = largeModelsRef.current;
    if (!models) {
      const b = modelOf(parseJson(baseText));
      const l = modelOf(parseJson(leftText));
      const r = modelOf(parseJson(rightText));
      if (!b || !l || !r) return; // unreachable when the worker merge succeeded
      models = { base: b, left: l, right: r };
      largeModelsRef.current = models;
    }
    const current = mergeResult ?? threeWayMerge(models.base, models.left, models.right);
    setMergeResult(
      resolveConflict(current, path, side, models.base, models.left, models.right),
    );
  };

  // Conflicts driving the UI: the model-based result once available, otherwise
  // the worker's initial conflict list for a large merge.
  const conflicts: Conflict[] = mergeResult
    ? mergeResult.conflicts
    : large && largeResult
      ? largeResult.conflicts
      : [];

  // Readiness: small inputs need all models; large inputs need a worker result
  // (or a resolved model-based result).
  const allReady = large
    ? largeResult !== null || mergeResult !== null
    : smallReady;

  const unresolvedCount = conflicts.length;
  // Export is allowed only once every conflict is resolved (Req 11.7, 11.8).
  const canExport = allReady && unresolvedCount === 0;
  const mergedText = useMemo(() => {
    if (!canExport) return '';
    if (mergeResult) return format(mergeResult.merged, EXPORT_INDENT);
    if (large && largeResult) return largeResult.mergedText;
    return '';
  }, [canExport, mergeResult, large, largeResult]);

  const [copied, setCopied] = useState(false);
  const copyMerged = async () => {
    try {
      await navigator.clipboard.writeText(mergedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div class="flex h-full flex-col gap-4 overflow-auto bg-canvas-soft p-4" data-component="merge-panel">
      <h2 class="font-sans text-display-sm text-ink">Three-way merge</h2>

      {/* Base / Left / Right inputs with per-document validation (Req 11.9). */}
      <div class="grid gap-4 lg:grid-cols-3">
        <DocumentInput role="base" value={baseText} parsed={baseParsed} onInput={setBaseText} />
        <DocumentInput role="left" value={leftText} parsed={leftParsed} onInput={setLeftText} />
        <DocumentInput role="right" value={rightText} parsed={rightParsed} onInput={setRightText} />
      </div>

      {/* Large-document worker progress (Req 17.3). */}
      {progress !== null && (
        <p
          class="font-sans text-caption text-mute"
          role="status"
          aria-live="polite"
          data-status="merge-progress"
        >
          Merging large documents… {Math.round(progress * 100)}%
        </p>
      )}

      {/* Worker failure reason; the prior result is retained (Req 17.5). */}
      {workerError && (
        <p
          class="font-sans text-body-sm text-error-deep"
          role="alert"
          data-status="merge-worker-error"
        >
          Merge failed: {workerError}
        </p>
      )}

      {/* Conflicts + resolution (Req 11.5, 11.6). */}
      {allReady && (
        <section data-section="conflicts">
          {unresolvedCount > 0 ? (
            <>
              <h3 class="mb-2 font-sans text-body-md-strong text-ink">
                Conflicts
              </h3>
              <ul class="flex flex-col gap-3" data-conflict-list>
                {conflicts.map((conflict) => (
                  <ConflictRow
                    key={conflict.path}
                    conflict={conflict}
                    onResolve={handleResolve}
                  />
                ))}
              </ul>
            </>
          ) : (
            <p class="font-sans text-body-sm text-body" data-status="no-conflicts">
              No conflicts. The merged document is ready to export.
            </p>
          )}
        </section>
      )}

      {/* Export gating (Req 11.7) + merged output (Req 11.8). */}
      <section class="mt-auto" data-section="export">
        {!allReady ? (
          // While a large merge is computing, the progress banner speaks for the
          // panel; the awaiting-input hint is only for genuinely missing input.
          progress === null ? (
            <p class="font-sans text-body-sm text-mute" data-status="awaiting-input">
              Provide valid Base, Left, and Right documents to compute a merge.
            </p>
          ) : null
        ) : !canExport ? (
          <div
            class="rounded-sm border border-error-soft bg-error-soft/40 p-3"
            data-status="export-blocked"
            role="status"
          >
            <p class="font-sans text-body-sm-strong text-error-deep">
              Export blocked: {unresolvedCount} unresolved{' '}
              {unresolvedCount === 1 ? 'conflict' : 'conflicts'}
            </p>
            <p class="mt-1 font-sans text-caption text-body">
              Resolve every conflict above to export the merged document.
            </p>
          </div>
        ) : (
          <div data-status="export-ready">
            <div class="mb-2 flex items-center justify-between gap-2">
              <h3 class="font-sans text-body-md-strong text-ink">Merged document</h3>
              <button
                type="button"
                class="rounded-sm bg-primary px-3 py-1.5 font-sans text-button-md text-on-primary"
                data-action="copy-merged"
                onClick={copyMerged}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <textarea
              class="h-48 w-full resize-y rounded-sm border border-hairline bg-canvas p-2 font-mono text-code text-ink"
              data-output="merged"
              readOnly
              spellcheck={false}
              value={mergedText}
            />
          </div>
        )}
      </section>
    </div>
  );
}

export default MergePanel;
