/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 14.3
//
// PatchExport — the RFC 6902 JSON Patch export surface for the Diff Checker
// (Req 10.4–10.6).
//
// Given a Left and a Right document — supplied either as raw text or as already
// parsed `JsonNode` models — the panel computes the minimal RFC 6902 patch that
// transforms Left into Right via the pure `toJsonPatch` core, renders the
// complete patch text, and offers a single control to copy it to the clipboard:
//
//   • Req 10.4 — a copy control writes the COMPLETE JSON_Patch text (the full
//     pretty-printed array, including the empty `[]` for equivalent documents)
//     to the system clipboard.
//   • Req 10.5 — when the clipboard write resolves, a confirmation indication is
//     shown. It appears synchronously on resolve (well within 1 s) and is held
//     briefly before dismissing.
//   • Req 10.6 — when the clipboard write rejects (or clipboard access is
//     denied), an error indication is shown AND the displayed patch is retained
//     unchanged. The rendered patch is derived purely from the Left/Right inputs
//     and is never mutated by a copy attempt, so the "retain unchanged"
//     guarantee holds structurally.
//
// When either document is supplied as text and fails to parse, the panel cannot
// compute a patch; it surfaces a brief validation note naming the offending
// document (the validation error state defined in Req 6) instead of a patch,
// and the copy control is disabled.
//
// The clipboard writer is injectable (mirroring `TreeRow`) so tests can drive
// both the success and failure paths deterministically. All styling is
// token-driven (theme.css); no hardcoded design values.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseJson, type ParseResult } from '../../lib/json-core/parse';
import { toJsonPatch, type JsonPatchOperation } from '../../lib/json-core/patch';
import { serialize } from '../../lib/json-core/serialize';
import type { JsonNode } from '../../lib/json-core/types';
import { isLargeDocument } from '../../lib/workers/large-document';
import { JobCancelledError } from '../../lib/workers/worker-client';
import { useLazyWorkerClient } from '../../lib/workers/use-worker-client';

/**
 * How long the copy confirmation / error indicator stays visible before
 * dismissing. The indicator appears synchronously on the clipboard
 * resolve/reject, so the Req 10.5 "within 1 second" budget is met regardless of
 * this hold duration.
 */
export const PATCH_COPY_INDICATOR_MS = 2000;

/** A document supplied to the panel: raw text or an already-parsed model. */
export type PatchDocument = string | JsonNode;

/** The transient state of the copy indicator. */
type CopyState = 'idle' | 'copied' | 'error';

/** Which side a parse failure occurred on, for the validation note. */
type DocRole = 'left' | 'right';

/** Human label for each document role. */
const ROLE_LABEL: Record<DocRole, string> = {
  left: 'Left',
  right: 'Right',
};

/** Props for {@link PatchExport}. */
export interface PatchExportProps {
  /** The Left (original) document — text or a parsed model. */
  left: PatchDocument;
  /** The Right (modified) document — text or a parsed model. */
  right: PatchDocument;
  /**
   * Clipboard writer. Defaults to `navigator.clipboard.writeText`. Injectable
   * so tests can simulate success and failure (Req 10.5, 10.6).
   */
  writeClipboard?: (text: string) => Promise<void>;
}

/** Default clipboard writer backed by the async Clipboard API. */
function defaultWriteClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('Clipboard API is unavailable'));
}

/**
 * The model resolved from a {@link PatchDocument}, or a located parse error.
 * A parsed-model input is always `ok`. A text input may fail to parse; the
 * valid-empty state (empty/whitespace-only text) resolves to the empty object
 * model so an empty document can still be diffed against a populated one.
 */
type ResolvedDoc =
  | { ok: true; model: JsonNode }
  | { ok: false; error: { line: number; column: number; message: string } };

/** An empty-object model used to represent valid-empty (whitespace-only) text. */
function emptyObjectModel(): JsonNode {
  return { id: '$', key: null, type: 'object', children: [] };
}

/** Resolve a {@link PatchDocument} to a model or a parse error. */
function resolveDocument(doc: PatchDocument): ResolvedDoc {
  if (typeof doc !== 'string') {
    return { ok: true, model: doc };
  }
  const parsed: ParseResult = parseJson(doc);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  // Valid-empty text carries no model; treat it as an empty object so it can be
  // diffed against the other document.
  return { ok: true, model: parsed.empty ? emptyObjectModel() : parsed.model };
}

/**
 * The RFC 6902 patch text export panel. Computes the patch from Left/Right,
 * renders the complete patch text, and provides a clipboard copy control with
 * confirmation and failure indications.
 */
export function PatchExport({
  left,
  right,
  writeClipboard = defaultWriteClipboard,
}: PatchExportProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tear down the indicator timer on unmount.
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  // A text side counts as a Large_Document when it crosses the 5 MB threshold;
  // a pre-parsed model side never triggers the worker path on its own.
  const leftLarge = typeof left === 'string' && isLargeDocument(left);
  const rightLarge = typeof right === 'string' && isLargeDocument(right);
  const large = leftLarge || rightLarge;

  // ── Small (synchronous) path ─────────────────────────────────────────────
  // Resolve + diff on the main thread only for small inputs; for large inputs
  // these are skipped so no multi-megabyte parse runs on the main thread.
  const leftDoc = useMemo(
    () => (large ? null : resolveDocument(left)),
    [large, left],
  );
  const rightDoc = useMemo(
    () => (large ? null : resolveDocument(right)),
    [large, right],
  );

  const syncPatch: JsonPatchOperation[] | null = useMemo(() => {
    if (large || !leftDoc || !rightDoc || !leftDoc.ok || !rightDoc.ok) {
      return null;
    }
    return toJsonPatch(leftDoc.model, rightDoc.model);
  }, [large, leftDoc, rightDoc]);

  // ── Large (worker) path ──────────────────────────────────────────────────
  const [asyncPatch, setAsyncPatch] = useState<JsonPatchOperation[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);

  const runPatch = useLazyWorkerClient(
    () =>
      new Worker(new URL('../../lib/workers/diff.worker.ts', import.meta.url), {
        type: 'module',
      }),
  );

  useEffect(() => {
    if (!large) {
      setProgress(null);
      setWorkerError(null);
      return;
    }

    // Send both sides as text; serialize a pre-parsed model side verbatim.
    const leftSide = typeof left === 'string' ? left : serialize(left);
    const rightSide = typeof right === 'string' ? right : serialize(right);

    let cancelled = false;
    setProgress(0);
    setWorkerError(null);

    runPatch<JsonPatchOperation[], { left: string; right: string }>(
      'patch',
      { left: leftSide, right: rightSide },
      {
        key: 'patch',
        onProgress: (value) => {
          if (!cancelled) setProgress(value);
        },
      },
    )
      .then((operations) => {
        if (cancelled) return;
        setAsyncPatch(operations); // render on completion (Req 17.4)
        setProgress(null);
      })
      .catch((err: unknown) => {
        // A superseded computation (newer edit) is expected; ignore it.
        if (cancelled || err instanceof JobCancelledError) return;
        // Failure: retain the prior patch and surface the reason (Req 17.5).
        setProgress(null);
        setWorkerError(
          err instanceof Error && err.message
            ? err.message
            : 'Computing the patch failed unexpectedly.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [large, left, right, runPatch]);

  // The patch to render/copy: the synchronous one for small inputs, or the
  // worker-produced one for large inputs.
  const patch: JsonPatchOperation[] | null = large ? asyncPatch : syncPatch;

  // The complete patch text (Req 10.4): the full pretty-printed array, which is
  // `[]` when the documents are structurally equivalent (Req 10.3).
  const patchText = useMemo(
    () => (patch === null ? '' : JSON.stringify(patch, null, 2)),
    [patch],
  );

  // Validation error state (Req 6) applies only on the synchronous path; on the
  // large path an unparsable side surfaces through `workerError` instead.
  const invalidRole: DocRole | null = large
    ? null
    : leftDoc && !leftDoc.ok
      ? 'left'
      : rightDoc && !rightDoc.ok
        ? 'right'
        : null;
  const invalidError =
    !large && leftDoc && !leftDoc.ok
      ? leftDoc.error
      : !large && rightDoc && !rightDoc.ok
        ? rightDoc.error
        : null;

  const isEmptyPatch = patch !== null && patch.length === 0;
  const canCopy = patch !== null;

  /** Show the indicator immediately and hold it briefly (Req 10.5/10.6). */
  function flashCopyState(state: CopyState) {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    setCopyState(state);
    copyTimer.current = setTimeout(
      () => setCopyState('idle'),
      PATCH_COPY_INDICATOR_MS,
    );
  }

  /**
   * Copy the complete patch text to the clipboard. On success show the
   * confirmation (Req 10.5); on failure show the error indication and leave the
   * displayed patch untouched (Req 10.6).
   */
  async function copyPatch() {
    if (patch === null) return;
    try {
      await writeClipboard(patchText);
      flashCopyState('copied');
    } catch {
      flashCopyState('error');
    }
  }

  return (
    <section
      class="flex h-full flex-col gap-3 overflow-auto bg-canvas-soft p-4"
      data-component="patch-export"
    >
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-sans text-display-sm text-ink">JSON Patch (RFC 6902)</h2>

        {/* Copy control (Req 10.4). */}
        <div class="flex items-center gap-2">
          {copyState === 'copied' ? (
            <span
              class="font-sans text-caption text-badge-bool"
              role="status"
              data-testid="patch-copy-confirmation"
            >
              Copied to clipboard
            </span>
          ) : null}
          {copyState === 'error' ? (
            <span
              class="font-sans text-caption text-error"
              role="status"
              data-testid="patch-copy-error"
            >
              Copy failed
            </span>
          ) : null}
          <button
            type="button"
            class="rounded-sm bg-primary px-3 py-1.5 font-sans text-button-md text-on-primary disabled:opacity-50"
            data-action="copy-patch"
            aria-label="Copy JSON Patch to clipboard"
            disabled={!canCopy}
            onClick={copyPatch}
          >
            Copy patch
          </button>
        </div>
      </div>

      {/* Large-document worker progress (Req 17.3). */}
      {progress !== null ? (
        <p
          class="font-sans text-caption text-mute"
          role="status"
          aria-live="polite"
          data-region="patch-progress"
        >
          Computing patch for large documents… {Math.round(progress * 100)}%
        </p>
      ) : null}

      {/* Worker failure reason; the prior patch is retained (Req 17.5). */}
      {workerError ? (
        <p
          class="font-sans text-body-sm text-error"
          role="alert"
          data-region="patch-worker-error"
        >
          Patch computation failed: {workerError}
        </p>
      ) : null}

      {invalidRole && invalidError ? (
        // Validation error state (Req 6) — a patch cannot be computed.
        <p
          class="inline-flex items-center gap-1.5 font-sans text-caption text-error"
          data-status="error"
          data-role={invalidRole}
          role="status"
          aria-label={`Invalid ${ROLE_LABEL[invalidRole]} document: ${invalidError.message}`}
          title={invalidError.message}
        >
          <span class="max-w-[48ch] truncate">
            {ROLE_LABEL[invalidRole]} document is not valid JSON: {invalidError.message}
          </span>
          <span class="font-mono text-caption-mono text-error-deep">
            {invalidError.line}:{invalidError.column}
          </span>
        </p>
      ) : (
        <>
          {isEmptyPatch ? (
            <p
              class="font-sans text-body-sm text-body"
              data-status="empty-patch"
            >
              The documents are structurally equivalent — the patch is empty.
            </p>
          ) : null}
          {/* The complete, rendered RFC 6902 patch text (Req 10.4, 10.6). */}
          <textarea
            class="min-h-48 w-full flex-1 resize-y rounded-sm border border-hairline bg-canvas p-2 font-mono text-code text-ink"
            data-output="patch"
            data-testid="patch-text"
            readOnly
            spellcheck={false}
            aria-label="RFC 6902 JSON Patch"
            value={patchText}
          />
        </>
      )}
    </section>
  );
}

export default PatchExport;
