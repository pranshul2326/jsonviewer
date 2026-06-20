// Feature: json-viewer-free
//
// Unit tests for `generateCode` in `quicktype.ts` (Req 14).
//
// What these tests assert, per the acceptance criteria:
//   - For each of the five language targets (Req 14.1 TypeScript, 14.2 Java,
//     14.3 Go, 14.4 Python, 14.5 Dart): a representative *nested* JSON sample
//     produces syntactically plausible source containing more than one
//     *distinct named definition* — each distinct object value maps to exactly
//     one named definition. The nested sample (a root object, a nested object,
//     and an array of objects) forces quicktype to mint three distinct names.
//   - Empty / whitespace-only input surfaces the validation error state
//     (Req 14.8): `{ ok: false }` with an empty-input reason.
//   - Syntactically invalid JSON surfaces the validation error state
//     (Req 14.7): `{ ok: false }` with an "Invalid JSON" reason.
//
// "Syntactically valid" is checked structurally without invoking five external
// compilers: the output must be non-empty, have balanced brackets, and contain
// the language's definition construct. Combined with the distinct-name checks
// this is a strong, fast proxy for well-formed type definitions.

import { describe, expect, it } from 'vitest';
import {
  CODE_LANGUAGES,
  generateCode,
  type CodeGenResult,
  type CodeLanguage,
} from './quicktype';

// A representative nested sample: a root object containing a nested object
// (`profile`), a scalar array (`tags`), and an array of objects (`projects`).
// quicktype infers three distinct object shapes => three named definitions.
const NESTED_SAMPLE = JSON.stringify({
  id: 1,
  name: 'Ada',
  active: true,
  profile: { age: 36, city: 'London' },
  tags: ['dev', 'math'],
  projects: [{ title: 'Engine', year: 1843 }],
});

/** Assert a generation result succeeded and return its code. */
function expectOk(result: CodeGenResult): string {
  expect(result.ok).toBe(true);
  // Narrow the union for the caller.
  if (!result.ok) throw new Error(`expected ok result, got: ${result.error}`);
  expect(result.code.trim().length).toBeGreaterThan(0);
  return result.code;
}

/** True when every kind of bracket is balanced in reading order. */
function bracketsBalanced(code: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack: string[] = [];
  for (const ch of code) {
    if (opens.has(ch)) {
      stack.push(ch);
    } else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}

/**
 * Extract the names of the top-level type definitions a target emits. Each
 * language declares definitions with a distinctive construct; we capture the
 * declared identifier so callers can assert distinctness and count.
 */
const DEFINITION_PATTERN: Record<CodeLanguage, RegExp> = {
  typescript: /\binterface\s+(\w+)/g,
  java: /\bclass\s+(\w+)/g,
  go: /\btype\s+(\w+)\s+struct\b/g,
  python: /\bclass\s+(\w+)/g,
  dart: /\bclass\s+(\w+)/g,
};

function definitionNames(language: CodeLanguage, code: string): string[] {
  const pattern = DEFINITION_PATTERN[language];
  pattern.lastIndex = 0;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    names.push(match[1]);
  }
  return names;
}

describe('generateCode — language targets (Req 14.1–14.5)', () => {
  // Map each language to the requirement it satisfies, for readable names.
  const cases: { language: CodeLanguage; req: string }[] = [
    { language: 'typescript', req: '14.1' },
    { language: 'java', req: '14.2' },
    { language: 'go', req: '14.3' },
    { language: 'python', req: '14.4' },
    { language: 'dart', req: '14.5' },
  ];

  it.each(cases)(
    'emits syntactically valid, distinct named definitions for $language (Req $req)',
    async ({ language }) => {
      const code = expectOk(await generateCode(NESTED_SAMPLE, language));

      // Syntactically plausible: balanced brackets across the whole source.
      expect(bracketsBalanced(code)).toBe(true);

      // The nested sample has three distinct object shapes, so we expect at
      // least three named definitions, and every name must be distinct
      // (each distinct object value maps to exactly one named definition).
      const names = definitionNames(language, code);
      expect(names.length).toBeGreaterThanOrEqual(3);
      expect(new Set(names).size).toBe(names.length);
    },
  );

  it('exposes exactly the five documented targets', () => {
    expect([...CODE_LANGUAGES].sort()).toEqual(
      ['dart', 'go', 'java', 'python', 'typescript'].sort(),
    );
  });
});

describe('generateCode — validation error state (Req 14.7, 14.8)', () => {
  it.each(CODE_LANGUAGES)(
    'surfaces the error state for empty input in %s (Req 14.8)',
    async (language) => {
      const result = await generateCode('', language);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/empty/i);
    },
  );

  it.each(CODE_LANGUAGES)(
    'surfaces the error state for whitespace-only input in %s (Req 14.8)',
    async (language) => {
      const result = await generateCode('   \n\t  ', language);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/empty/i);
    },
  );

  it.each(CODE_LANGUAGES)(
    'surfaces the error state for invalid JSON in %s (Req 14.7)',
    async (language) => {
      const result = await generateCode('{ "broken": ', language);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid json/i);
    },
  );
});
