/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 16.2
//
// CodeGenPanel — the Code Generator tool. It turns the shared JSON document into
// typed data-structure definitions in one of five target languages and lets the
// user copy the result to the clipboard (Req 14.6–14.9).
//
// It dispatches the `codegen` op to `codegen.worker.ts` through the shared
// `WorkerClient`, exactly like ConvertPanel, so the genuinely long-running
// quicktype pipeline runs off the main thread and the UI stays responsive
// (Req 17.x). The generator is injectable via the `generate` prop so tests can
// exercise the panel without a real `Worker` (which Vite builds from
// `import.meta.url`).
//
// To keep `quicktype-core` out of the island bundle, this module imports NO
// values from `lib/codegen/quicktype.ts`; it re-declares the small set of
// language ids and the result shape structurally (the same decoupling
// ConvertPanel uses for the converters).
//
// Behavior mapped to requirements:
//   • Language selection — TypeScript / Java / Go / Python / Dart (Req 14.6 set,
//     matching Req 14.1–14.5). Generation reads the live shared `$document`.
//   • Copy (Req 14.6) — a control copies the complete generated code to the
//     clipboard and shows a visible confirmation when the write completes.
//   • Copy failure (Req 14.9) — if the clipboard write fails, an error
//     indication is shown and the displayed generated code is retained unchanged.
//   • Validation error state (Req 14.7, 14.8) — empty/whitespace-only input and
//     syntactically invalid JSON both render the shared validation error state
//     instead of code. Empty input is short-circuited on the main thread; the
//     generator itself reports invalid JSON as a `{ ok: false, error }` result,
//     which the panel renders in the same error surface.

import { useStore } from '@nanostores/preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { $document } from '../../lib/stores/document';
import {
  JobCancelledError,
  WorkerClient,
} from '../../lib/workers/worker-client';

/**
 * The five code-generation targets (Req 14.1–14.5). Re-declared locally (rather
 * than imported from `lib/codegen/quicktype.ts`) so `quicktype-core` is never
 * pulled into the island bundle — generation runs in the worker.
 */
export type CodeLanguage = 'typescript' | 'java' | 'go' | 'python' | 'dart';

/** Serializable inputs for the `codegen` worker op (mirrors the worker payload). */
export interface CodeGenPayload {
  /** The JSON sample to generate typed definitions from. */
  text: string;
  /** The target language for the generated definitions. */
  language: CodeLanguage;
}

/**
 * The discriminated result the generator returns (and the worker forwards
 * verbatim): the complete generated `code`, or a human-readable `error` for
 * empty/invalid input or a generation failure. Structurally identical to the
 * core's own `CodeGenResult`.
 */
export type CodeGenResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

/** A generator function: dispatches a job and resolves with its typed result. */
export type GenerateFn = (
  payload: CodeGenPayload,
  onProgress?: (progress: number) => void,
) => Promise<CodeGenResult>;

/** Props for {@link CodeGenPanel}. */
export interface CodeGenPanelProps {
  /**
   * Inject a generator for testing. When omitted, a real `WorkerClient` over
   * `codegen.worker.ts` is created lazily and used.
   */
  generate?: GenerateFn;
}

/** Display metadata for each language, in display order (Req 14.1–14.5). */
const LANGUAGES: ReadonlyArray<{ id: CodeLanguage; label: string }> = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' },
  { id: 'python', label: 'Python' },
  { id: 'dart', label: 'Dart' },
] as const;

/** Lifecycle of a single generation attempt. */
type Status = 'idle' | 'generating' | 'done' | 'error';

/**
 * Message shown for empty/whitespace-only input (Req 14.8). It is rendered as a
 * single self-contained line (no separate "Cannot generate code" heading) since
 * the heading would be redundant; genuine errors keep the heading + detail.
 */
const EMPTY_INPUT_MESSAGE = 'Cannot generate code from empty input.';

/**
 * The Code Generator panel. Selects a target language, generates typed
 * definitions from the shared JSON document in a worker, and renders either the
 * generated source (with a copy control) or the validation error state.
 */
export default function CodeGenPanel({ generate }: CodeGenPanelProps) {
  const doc = useStore($document);

  const [language, setLanguage] = useState<CodeLanguage>('typescript');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  // Copy feedback: `null` = no feedback, `true` = confirmed, `false` = failed.
  const [copyState, setCopyState] = useState<boolean | null>(null);

  const sourceText = doc.text;

  // ── Worker client (lazy, disposed on unmount) ───────────────────────────
  const clientRef = useRef<WorkerClient | null>(null);
  useEffect(() => {
    return () => {
      clientRef.current?.dispose(true);
      clientRef.current = null;
    };
  }, []);

  const runGenerate = useCallback<GenerateFn>(
    (payload, onProgress) => {
      if (generate) return generate(payload, onProgress);
      if (!clientRef.current) {
        const worker = new Worker(
          new URL('../../lib/workers/codegen.worker.ts', import.meta.url),
          { type: 'module' },
        );
        clientRef.current = new WorkerClient(worker);
      }
      // `key: 'codegen'` supersedes any in-flight generation so rapid edits or
      // language changes don't queue stale work (Req 17.5).
      return clientRef.current.run<CodeGenResult, CodeGenPayload>(
        'codegen',
        payload,
        { key: 'codegen', onProgress },
      );
    },
    [generate],
  );

  // ── Generate on any change to source / language (debounced) ──────────────
  useEffect(() => {
    setCopyState(null);

    // Empty/whitespace-only input: show the validation error state (Req 14.8)
    // without a worker round-trip. No code is displayed.
    if (sourceText.trim() === '') {
      setCode('');
      setError(EMPTY_INPUT_MESSAGE);
      setStatus('error');
      return;
    }

    let cancelled = false;
    setStatus('generating');

    const timer = setTimeout(() => {
      runGenerate({ text: sourceText, language })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setCode(result.code);
            setError(null);
            setStatus('done');
          } else {
            // Invalid JSON (Req 14.7) or a generation failure: render the
            // validation error state in place of code. Clear stale output so a
            // mismatched previous result is never shown alongside the error.
            setCode('');
            setError(result.error);
            setStatus('error');
          }
        })
        .catch((err: unknown) => {
          // A superseded/cancelled job is expected during rapid changes; ignore.
          if (cancelled || err instanceof JobCancelledError) return;
          setCode('');
          setError(
            err instanceof Error && err.message
              ? err.message
              : 'Code generation failed unexpectedly.',
          );
          setStatus('error');
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceText, language, runGenerate]);

  const languageLabel = LANGUAGES.find((l) => l.id === language)!.label;

  // ── Copy generated code (Req 14.6 confirmation / Req 14.9 failure) ───────
  const onCopy = async () => {
    if (code === '') return;
    try {
      await navigator.clipboard.writeText(code);
      // Visible confirmation; the displayed code is unchanged.
      setCopyState(true);
      window.setTimeout(() => setCopyState(null), 2000);
    } catch {
      // Clipboard write failed: show an error indication and retain the
      // displayed generated code unchanged (Req 14.9).
      setCopyState(false);
      window.setTimeout(() => setCopyState(null), 4000);
    }
  };

  return (
    <section
      aria-label="Code generator panel"
      data-tool-panel="codegen"
      class="flex h-full min-h-0 flex-col gap-md"
    >
      {/* ── Controls ─────────────────────────────────────────────────── */}
      <div class="flex flex-wrap items-center gap-md">
        <div role="group" aria-label="Target language" class="flex items-center gap-xxs">
          {LANGUAGES.map((l) => {
            const selected = l.id === language;
            return (
              <button
                key={l.id}
                type="button"
                aria-pressed={selected}
                class={
                  'rounded-xs px-sm py-xxs text-button-md ring-1 ring-inset ' +
                  (selected
                    ? 'bg-primary text-on-primary ring-primary'
                    : 'text-body ring-hairline hover:bg-canvas-soft')
                }
                onClick={() => setLanguage(l.id)}
              >
                {l.label}
              </button>
            );
          })}
        </div>

        <span class="ml-auto text-caption text-mute" aria-live="polite">
          {status === 'generating' ? 'Generating…' : ''}
        </span>
      </div>

      {/* ── Output ───────────────────────────────────────────────────── */}
      <div class="flex min-h-0 flex-1 flex-col gap-xs">
        <div class="flex items-center gap-xs">
          <label class="text-body-sm-strong text-ink" for="codegen-output">
            {`Output · ${languageLabel}`}
          </label>
          <div class="ml-auto flex items-center gap-xs">
            {copyState === true ? (
              <span class="text-caption text-success" role="status" aria-live="polite">
                Copied
              </span>
            ) : null}
            {copyState === false ? (
              <span class="text-caption text-error-deep" role="alert">
                Copy failed
              </span>
            ) : null}
            {status === 'done' && code !== '' ? (
              <button
                type="button"
                class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
                onClick={onCopy}
              >
                Copy
              </button>
            ) : null}
          </div>
        </div>

        {status === 'error' && error ? (
          // The shared validation error state (Req 14.7, 14.8). Empty input
          // renders a single self-contained line; other errors show the generic
          // heading plus the specific detail message.
          <div
            role="alert"
            class="min-h-[280px] w-full flex-1 overflow-auto rounded-sm border border-error bg-error-soft p-sm"
          >
            {error === EMPTY_INPUT_MESSAGE ? (
              <p class="text-body-sm-strong text-error-deep">{error}</p>
            ) : (
              <>
                <p class="text-body-sm-strong text-error-deep">Cannot generate code</p>
                <p class="mt-xs text-body-sm text-error-deep">{error}</p>
              </>
            )}
          </div>
        ) : (
          <textarea
            id="codegen-output"
            readOnly
            aria-label={`Generated ${languageLabel}`}
            class="min-h-[280px] w-full flex-1 resize-none rounded-sm border border-divider bg-canvas-soft p-sm font-mono text-code text-body"
            value={code}
            placeholder={`Provide JSON to see the ${languageLabel} definitions.`}
          />
        )}
      </div>
    </section>
  );
}
