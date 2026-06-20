// Feature: json-viewer-free
//
// Canonicalization and structural equality for the pure `json-core` library.
//
//   canonicalize(node)        : JsonNode -> Canonical
//   structuralEquals(a, b)    : (JsonNode, JsonNode) -> boolean
//
// `canonicalize` produces a normalized, deterministic representation of a
// `JsonNode` tree in which:
//   - object members are sorted by key (so key ordering is irrelevant),
//   - array elements keep their order (order is significant for arrays),
//   - number lexemes are normalized to a canonical numeric form so that values
//     that are numerically equal compare equal regardless of how they were
//     written (e.g. `1.0` ≡ `1`, `1e2` ≡ `100`), without losing precision for
//     big integers or high-precision decimals,
//   - scalars are tagged with their type so that, e.g., the string "1" never
//     collides with the number 1.
//
// `structuralEquals` is the single oracle used for every equivalence check in
// the system (diff-soundness, patch-correctness, merge equivalence). Two
// documents are structurally equal exactly when their canonical forms are
// deeply equal, which captures the requirement that every JSON_Path resolves to
// the same scalar value irrespective of object key ordering and insignificant
// whitespace (Req 8.7).

import type { JsonNode } from './types';

/**
 * The canonical, deterministic representation of a `JsonNode`. Scalars are
 * tagged with their kind so values of different types never compare equal; an
 * object's entries are sorted by key; an array's items keep source order.
 */
export type Canonical =
  | { kind: 'null' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string } // normalized numeric lexeme
  | { kind: 'array'; items: Canonical[] }
  | { kind: 'object'; entries: Array<[string, Canonical]> }; // sorted by key

/**
 * Normalize a JSON number lexeme to a canonical form of the shape
 * `[-]<coefficient>E<exponent>`, where `coefficient` is an integer with no
 * leading or trailing zeros. Two lexemes denoting the same numeric value
 * produce identical normalized strings, and zero always normalizes to `"0"`.
 *
 * The normalization is purely string/integer based, so arbitrary precision
 * (large integers and long fractional parts) is preserved without rounding.
 *
 * Examples: `"1.0"` → `"1E0"`, `"1"` → `"1E0"`, `"1e2"` → `"1E2"`,
 * `"100"` → `"1E2"`, `"-0.0500"` → `"-5E-2"`, `"0"`/`"-0"` → `"0"`.
 */
export function normalizeNumberLexeme(lexeme: string): string {
  const text = lexeme.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) {
    // Not a recognizable JSON number lexeme; fall back to the trimmed text so
    // identical raw lexemes still compare equal.
    return text;
  }

  const sign = match[1] === '-' ? '-' : '';
  const intPart = match[2];
  const fracPart = match[3] ?? '';
  const expPart = match[4];

  // Combine the integer and fractional digits into a single coefficient and
  // track the decimal exponent. Each fractional digit lowers the exponent by 1.
  let digits = intPart + fracPart;
  let exponent = (expPart ? parseInt(expPart, 10) : 0) - fracPart.length;

  // Strip leading zeros from the coefficient.
  digits = digits.replace(/^0+/, '');
  if (digits === '') {
    // The value is zero regardless of sign or exponent.
    return '0';
  }

  // Strip trailing zeros, raising the exponent to compensate.
  const trimmed = digits.replace(/0+$/, '');
  exponent += digits.length - trimmed.length;
  digits = trimmed;

  return `${sign}${digits}E${exponent}`;
}

/**
 * Produce the canonical, deterministic representation of a `JsonNode` tree.
 *
 * Object members are sorted by key, array order is preserved, number lexemes
 * are normalized, and scalars are tagged with their type. Equal canonical
 * forms denote structurally equivalent documents.
 */
export function canonicalize(node: JsonNode): Canonical {
  switch (node.type) {
    case 'null':
      return { kind: 'null' };
    case 'boolean':
      return { kind: 'bool', value: node.boolValue ?? false };
    case 'string':
      return { kind: 'string', value: node.stringValue ?? '' };
    case 'number':
      return { kind: 'number', value: normalizeNumberLexeme(node.numberValue ?? '0') };
    case 'array':
      return {
        kind: 'array',
        items: (node.children ?? []).map((child) => canonicalize(child)),
      };
    case 'object': {
      const entries: Array<[string, Canonical]> = (node.children ?? []).map(
        (child) => [String(child.key), canonicalize(child)],
      );
      // Sort by key so object member ordering does not affect equality.
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return { kind: 'object', entries };
    }
    default: {
      // Exhaustiveness guard: every JsonType is handled above.
      const _exhaustive: never = node.type;
      throw new Error(`Unsupported JsonType: ${String(_exhaustive)}`);
    }
  }
}

/** Deep structural comparison of two canonical forms. */
function canonicalEquals(a: Canonical, b: Canonical): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case 'null':
      return true;
    case 'bool':
      return a.value === (b as Extract<Canonical, { kind: 'bool' }>).value;
    case 'string':
      return a.value === (b as Extract<Canonical, { kind: 'string' }>).value;
    case 'number':
      return a.value === (b as Extract<Canonical, { kind: 'number' }>).value;
    case 'array': {
      const other = b as Extract<Canonical, { kind: 'array' }>;
      if (a.items.length !== other.items.length) {
        return false;
      }
      for (let i = 0; i < a.items.length; i++) {
        if (!canonicalEquals(a.items[i], other.items[i])) {
          return false;
        }
      }
      return true;
    }
    case 'object': {
      const other = b as Extract<Canonical, { kind: 'object' }>;
      if (a.entries.length !== other.entries.length) {
        return false;
      }
      // Both entry lists are sorted by key, so a positional comparison suffices.
      for (let i = 0; i < a.entries.length; i++) {
        const [keyA, valueA] = a.entries[i];
        const [keyB, valueB] = other.entries[i];
        if (keyA !== keyB || !canonicalEquals(valueA, valueB)) {
          return false;
        }
      }
      return true;
    }
    default: {
      const _exhaustive: never = a;
      throw new Error(`Unsupported Canonical kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The structural-equality oracle: two `JsonNode` trees are structurally equal
 * when every JSON_Path resolves to the same scalar value in both, irrespective
 * of object key ordering and insignificant whitespace, and with numeric values
 * compared by value rather than by lexeme.
 */
export function structuralEquals(a: JsonNode, b: JsonNode): boolean {
  return canonicalEquals(canonicalize(a), canonicalize(b));
}
