// Feature: json-viewer-free
//
// `codegen.worker.ts` — the dedicated module worker that runs code generation
// off the main thread (Req 17.1, 17.4). It handles the `codegen` op of the
// shared worker protocol (`worker-protocol.ts`).
//
// The work delegates to `json-core`'s `generateCode`, which wraps
// `quicktype-core` and is asynchronous (the quicktype pipeline returns rendered
// lines via a promise). The handler therefore awaits it. `generateCode` already
// returns a typed `{ ok, code } | { ok, error }` result for empty/invalid input
// (the shared validation error state, Req 14.7/14.8), so that discriminated
// result is forwarded verbatim as the terminal `result`; the panel renders the
// generated source or the validation error from it. Only an unexpected
// exception becomes a terminal `error`.
//
// Because generation is genuinely long-running, the handler posts `progress` 0
// on entry, an intermediate `progress` 0.5 once input validation passes and the
// quicktype pipeline begins, and `progress` 1 immediately before the single
// terminal message.

import { generateCode, type CodeGenResult, type CodeLanguage } from '../codegen/quicktype';
import type {
  WorkerErrorResponse,
  WorkerProgressResponse,
  WorkerRequest,
  WorkerResultResponse,
} from './worker-protocol';

/** Inputs for the `codegen` op. */
interface CodegenPayload {
  /** The JSON sample to generate typed definitions from. */
  text: string;
  /** The target language for the generated definitions. */
  language: CodeLanguage;
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

  void (async () => {
    try {
      postProgress(jobId, 0);

      if (op !== 'codegen') {
        postError(jobId, `codegen.worker received unsupported op "${op}".`);
        return;
      }

      const { text, language } = request.payload as CodegenPayload;
      postProgress(jobId, 0.5);
      const result = await generateCode(
        typeof text === 'string' ? text : '',
        language,
      );
      postProgress(jobId, 1);
      postResult<CodeGenResult>(jobId, result);
    } catch (error) {
      postError(
        jobId,
        error instanceof Error && error.message
          ? error.message
          : 'Code generation failed unexpectedly.',
      );
    }
  })();
});
