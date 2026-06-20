// Feature: json-viewer-free
//
// `generateCode` — the code-generation core that turns a JSON sample into
// typed data-structure definitions in one of five target languages (Req 14).
//
// Design (see design.md "Component & Module Map" → `lib/codegen/quicktype.ts`
// and Req 14.1–14.5):
//   - We wrap `quicktype-core`, which can emit TypeScript, Java, Go, Python,
//     and Dart from a single JSON sample. quicktype infers, for each distinct
//     object shape, exactly one named definition; each property is typed by its
//     JSON value type and each array by its element type — precisely the
//     guarantees Req 14.1–14.5 demand.
//   - The pipeline is the canonical quicktype flow:
//       `jsonInputForTargetLanguage` → `InputData.addInput` → `quicktype()`.
//     `quicktype()` is async and returns rendered `lines`; this wrapper is
//     therefore async and joins the lines into a single source string.
//   - Per-language renderer options request *type definitions only* (no
//     (de)serialization helpers), so the output is the clean set of named
//     definitions the requirements describe.
//
// Validation (the "validation error state" referenced by Req 14.7 / 14.8):
//   - The core surfaces empty/whitespace-only input and syntactically invalid
//     JSON as an error result, detected with the shared `parseJson` entry
//     point so the panel can render the same validation error state used
//     everywhere else (Req 6).

import {
  quicktype,
  InputData,
  jsonInputForTargetLanguage,
  type RendererOptions,
} from 'quicktype-core';
import { parseJson } from '../json-core/parse';

/**
 * The five code-generation targets supported by the application (Req 14.1–14.5).
 */
export type CodeLanguage = 'typescript' | 'java' | 'go' | 'python' | 'dart';

/** Every supported target, in display order. */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  'typescript',
  'java',
  'go',
  'python',
  'dart',
];

/**
 * The outcome of a code-generation request.
 *
 *   - `{ ok: true, code }` — the complete generated source as a single string.
 *   - `{ ok: false, error }` — empty/invalid JSON (Req 14.7, 14.8) or a
 *     generation failure; `error` is a human-readable reason.
 */
export type CodeGenResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

/** The top-level type name used for the root of the generated definitions. */
const ROOT_TYPE_NAME = 'Root';

/**
 * Maps each `CodeLanguage` to the quicktype language name and the renderer
 * options that keep the output to pure type definitions.
 */
const LANGUAGE_CONFIG: Record<
  CodeLanguage,
  { name: CodeLanguage; rendererOptions: RendererOptions }
> = {
  // Interfaces only — no `toRoot`/`fromJson` converter functions.
  typescript: { name: 'typescript', rendererOptions: { 'just-types': 'true' } },
  // Plain POJOs — no Jackson/serialization annotations.
  java: { name: 'java', rendererOptions: { 'just-types': 'true' } },
  // Struct definitions only — no marshalling helpers.
  go: { name: 'go', rendererOptions: { 'just-types': 'true' } },
  // `@dataclass` definitions only — no (de)serialization helper functions.
  python: {
    name: 'python',
    rendererOptions: { 'python-version': '3.7', 'just-types': 'true' },
  },
  // Plain Dart classes — no JSON (de)serialization boilerplate.
  dart: { name: 'dart', rendererOptions: { 'just-types': 'true' } },
};

/**
 * Generate typed definitions for `jsonText` in `targetLanguage`.
 *
 * Empty/whitespace-only or syntactically invalid input is reported as an error
 * result (the validation error state, Req 14.7/14.8). On success the result
 * carries the complete generated source.
 */
export async function generateCode(
  jsonText: string,
  targetLanguage: CodeLanguage,
): Promise<CodeGenResult> {
  // Surface empty/invalid input as the shared validation error state.
  const parsed = parseJson(jsonText);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Invalid JSON: ${parsed.error.message}`,
    };
  }
  if (parsed.empty) {
    return {
      ok: false,
      error: 'Cannot generate code from empty input.',
    };
  }

  const config = LANGUAGE_CONFIG[targetLanguage];

  try {
    const jsonInput = jsonInputForTargetLanguage(config.name);
    await jsonInput.addSource({
      name: ROOT_TYPE_NAME,
      samples: [jsonText],
    });

    const inputData = new InputData();
    inputData.addInput(jsonInput);

    const { lines } = await quicktype({
      inputData,
      lang: config.name,
      rendererOptions: config.rendererOptions,
    });

    return { ok: true, code: lines.join('\n') };
  } catch (error) {
    const reason =
      error instanceof Error && error.message
        ? error.message
        : 'Unknown code-generation error.';
    return { ok: false, error: reason };
  }
}
