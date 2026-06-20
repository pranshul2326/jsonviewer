// Feature: json-viewer-free
//
// `parse.worker.ts` — the dedicated module worker that runs JSON parsing and
// validation off the main thread (Req 17.1, 17.4).
//
// It handles the `parse` and `validate` operations of the shared worker
// protocol (`worker-protocol.ts`). Both operations run the same `json-core`
// `parseJson` entry point, so worker-side and main-thread parsing behave
// identically (design.md "Worker Strategy"):
//
//   - `parse`    — returns the full `ParseResult` (including the `JsonNode`
//                  model on success, which is itself structured-clone-safe).
//   - `validate` — returns only the validity verdict (`ok`/`empty`/`error`),
//                  omitting the model so a large document's tree is not copied
//                  back across the worker boundary just to light the
//                  valid/error indicator.
//
// A run posts a `progress` 0 on entry and `progress` 1 immediately before its
// single terminal `result`. A syntactically invalid document is *not* a worker
// failure: it is reported as a normal `result` carrying the located parse error
// so the editor can render its inline validation state. Only an unexpected
// exception produces a terminal `error` message.

import { parseJson, type ParseErrorInfo } from '../json-core/parse';
import type {
  WorkerErrorResponse,
  WorkerProgressResponse,
  WorkerRequest,
  WorkerResultResponse,
} from './worker-protocol';

/** Inputs for the `parse`/`validate` operations: the document text. */
interface ParsePayload {
  /** The JSON document text to parse or validate. */
  text: string;
}

/** Result of a `parse` op: the full parse outcome (model included). */
type ParseResultPayload =
  | { ok: true; empty: false; model: import('../json-core/types').JsonNode }
  | { ok: true; empty: true; model: null }
  | { ok: false; error: ParseErrorInfo };

/** Result of a `validate` op: the validity verdict without the model. */
type ValidateResultPayload =
  | { ok: true; empty: boolean }
  | { ok: false; error: ParseErrorInfo };

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

/** Read the document text from a `parse`/`validate` payload. */
function textOf(payload: unknown): string {
  const text = (payload as ParsePayload | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

ctx.addEventListener('message', (event) => {
  const request = asRequest(event.data);
  if (request === null) {
    return;
  }
  const { jobId, op } = request;

  try {
    postProgress(jobId, 0);

    if (op === 'parse') {
      const result = parseJson(textOf(request.payload)) as ParseResultPayload;
      postProgress(jobId, 1);
      postResult<ParseResultPayload>(jobId, result);
      return;
    }

    if (op === 'validate') {
      const parsed = parseJson(textOf(request.payload));
      const verdict: ValidateResultPayload = parsed.ok
        ? { ok: true, empty: parsed.empty }
        : { ok: false, error: parsed.error };
      postProgress(jobId, 1);
      postResult<ValidateResultPayload>(jobId, verdict);
      return;
    }

    postError(jobId, `parse.worker received unsupported op "${op}".`);
  } catch (error) {
    postError(
      jobId,
      error instanceof Error && error.message
        ? error.message
        : 'Parsing failed unexpectedly.',
    );
  }
});
