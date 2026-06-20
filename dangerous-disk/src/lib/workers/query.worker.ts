// Feature: json-viewer-free
//
// `query.worker.ts` — the dedicated module worker that evaluates JSONPath and
// JMESPath expressions off the main thread (Req 17.1, 17.4). It handles the
// `query` op of the shared worker protocol (`worker-protocol.ts`).
//
// Running the query engine inside a worker is also the security boundary the
// design relies on: JSONPath is evaluated by `jsonpath-plus` with script
// evaluation disabled, and confining it to a worker keeps even that hardened
// evaluation off the main thread for 50 MB documents (design.md "Worker
// Strategy", Req 16.1/16.2).
//
// `runQuery` already returns a typed `{ ok, results } | { ok, error }` result
// (an empty `results` array means "no matches"; a typed `error` carries the
// problem and, where available, its character position — Req 16.3/16.4/16.6).
// That discriminated result is forwarded verbatim as the terminal `result` so
// the Query panel can render matches, the no-results indicator, or the located
// error and leave prior results unchanged. Only an unexpected exception becomes
// a terminal `error`.
//
// Each run posts `progress` 0 on entry and `progress` 1 immediately before its
// single terminal message.

import { runQuery, type QueryMode, type QueryResult } from '../query/engine';
import type {
  WorkerErrorResponse,
  WorkerProgressResponse,
  WorkerRequest,
  WorkerResultResponse,
} from './worker-protocol';

/** Inputs for the `query` op. */
interface QueryPayload {
  /** The JSON document text to query. */
  text: string;
  /** The query expression. */
  expression: string;
  /** Which query language the expression is written in. */
  mode: QueryMode;
}

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

ctx.addEventListener('message', (event) => {
  const request = asRequest(event.data);
  if (request === null) {
    return;
  }
  const { jobId, op } = request;

  try {
    postProgress(jobId, 0);

    if (op !== 'query') {
      postError(jobId, `query.worker received unsupported op "${op}".`);
      return;
    }

    const { text, expression, mode } = request.payload as QueryPayload;
    const result = runQuery(
      typeof text === 'string' ? text : '',
      typeof expression === 'string' ? expression : '',
      mode,
    );
    postProgress(jobId, 1);
    postResult<QueryResult>(jobId, result);
  } catch (error) {
    postError(
      jobId,
      error instanceof Error && error.message
        ? error.message
        : 'The query failed unexpectedly.',
    );
  }
});
