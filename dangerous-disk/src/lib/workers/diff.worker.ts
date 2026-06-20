// Feature: json-viewer-free
//
// `diff.worker.ts` — the dedicated module worker for the document-comparison
// operations (Req 17.1, 17.4). It handles three ops of the shared worker
// protocol (`worker-protocol.ts`):
//
//   - `diff`  — semantic (structural) diff of two documents → `Difference[]`.
//   - `patch` — RFC 6902 JSON Patch transforming Left into Right
//               → `JsonPatchOperation[]`.
//   - `merge` — three-way merge of Left and Right against a common Base
//               → the merged document as JSON text plus the open `Conflict[]`.
//
// All three operate on the `JsonNode` model, but the protocol only carries
// serializable text across the boundary, so each input document arrives as JSON
// text and is parsed *inside* the worker via `json-core`'s `parseJson` before
// the corresponding pure function runs. A document that cannot be parsed (a
// syntax error or empty input) is a genuine operation failure here — there is
// nothing to compare — so it produces a terminal `error` naming the offending
// side. The merged result is emitted as formatted JSON text (2-space indent),
// preserving object key order, array order, and numeric precision.
//
// Each run posts `progress` 0 on entry and `progress` 1 immediately before its
// single terminal `result` (or `error`).

import { parseJson } from '../json-core/parse';
import { semanticDiff, type Difference } from '../json-core/diff';
import { toJsonPatch, type JsonPatchOperation } from '../json-core/patch';
import { threeWayMerge, type Conflict } from '../json-core/merge';
import { format } from '../json-core/serialize';
import type { JsonNode } from '../json-core/types';
import type {
  WorkerErrorResponse,
  WorkerProgressResponse,
  WorkerRequest,
  WorkerResultResponse,
} from './worker-protocol';

/** Inputs for `diff`/`patch`: the Left and Right document texts. */
interface PairPayload {
  left: string;
  right: string;
}

/** Inputs for `merge`: the common Base plus the Left and Right document texts. */
interface MergePayload {
  base: string;
  left: string;
  right: string;
}

/** Result of a `merge` op: the merged document text and any open conflicts. */
interface MergeResultPayload {
  /** The merged document serialized as pretty-printed (2-space) JSON text. */
  merged: string;
  /** The conflicts still requiring resolution. */
  conflicts: Conflict[];
}

/** Pretty-print style used for the merged document text. */
const MERGE_INDENT = { kind: 'space', size: 2 } as const;

/**
 * The slice of the dedicated-worker global scope this entrypoint uses. Declared
 * structurally so it type-checks under the DOM lib without the WebWorker lib.
 */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
}

const ctx = self as unknown as WorkerScope;

/** Post a non-terminal progress message (completion fraction in [0, 1]). */
function postProgress(jobId: string, progress: number): void {
  const message: WorkerProgressResponse = { jobId, kind: 'progress', progress };
  ctx.postMessage(message);
}

/** Post the single terminal success message for a job. */
function postResult<R>(jobId: string, result: R): void {
  const message: WorkerResultResponse<R> = { jobId, kind: 'result', result };
  ctx.postMessage(message);
}

/** Post the single terminal failure message for a job. */
function postError(jobId: string, message: string): void {
  const response: WorkerErrorResponse = {
    jobId,
    kind: 'error',
    error: { message },
  };
  ctx.postMessage(response);
}

/** Narrow an unknown message to a well-formed `WorkerRequest`. */
function asRequest(data: unknown): WorkerRequest | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const candidate = data as { jobId?: unknown; op?: unknown };
  if (typeof candidate.jobId !== 'string' || typeof candidate.op !== 'string') {
    return null;
  }
  return data as WorkerRequest;
}

/**
 * Parse one input document into a `JsonNode`, throwing a descriptive error
 * (naming the `label` side) when the text is empty or syntactically invalid —
 * there is no model to compare or merge in that case.
 */
function parseSide(text: unknown, label: string): JsonNode {
  const source = typeof text === 'string' ? text : '';
  const parsed = parseJson(source);
  if (!parsed.ok) {
    throw new Error(
      `${label} document is not valid JSON: ${parsed.error.message}`,
    );
  }
  if (parsed.empty) {
    throw new Error(`${label} document is empty; there is nothing to compare.`);
  }
  return parsed.model;
}

ctx.addEventListener('message', (event) => {
  const request = asRequest(event.data);
  if (request === null) {
    return;
  }
  const { jobId, op } = request;

  try {
    postProgress(jobId, 0);

    if (op === 'diff') {
      const { left, right } = request.payload as PairPayload;
      const differences = semanticDiff(
        parseSide(left, 'Left'),
        parseSide(right, 'Right'),
      );
      postProgress(jobId, 1);
      postResult<Difference[]>(jobId, differences);
      return;
    }

    if (op === 'patch') {
      const { left, right } = request.payload as PairPayload;
      const operations = toJsonPatch(
        parseSide(left, 'Left'),
        parseSide(right, 'Right'),
      );
      postProgress(jobId, 1);
      postResult<JsonPatchOperation[]>(jobId, operations);
      return;
    }

    if (op === 'merge') {
      const { base, left, right } = request.payload as MergePayload;
      const result = threeWayMerge(
        parseSide(base, 'Base'),
        parseSide(left, 'Left'),
        parseSide(right, 'Right'),
      );
      const payload: MergeResultPayload = {
        merged: format(result.merged, MERGE_INDENT),
        conflicts: result.conflicts,
      };
      postProgress(jobId, 1);
      postResult<MergeResultPayload>(jobId, payload);
      return;
    }

    postError(jobId, `diff.worker received unsupported op "${op}".`);
  } catch (error) {
    postError(
      jobId,
      error instanceof Error && error.message
        ? error.message
        : 'The comparison failed unexpectedly.',
    );
  }
});
