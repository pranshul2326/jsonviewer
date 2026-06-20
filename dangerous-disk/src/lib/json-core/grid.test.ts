// Feature: json-viewer-free
//
// Property tests for the Table Grid transforms in `grid.ts` (Req 15).
//
//   - Property 26: Grid construction mirrors the array  (Req 15.1, 15.6)
//   - Property 27: Grid search/filter select exactly the matching rows
//                  (Req 15.2, 15.3, 15.4, 15.6)
//   - Property 28: Grid sort orders ascending then toggles to descending
//                  (Req 15.5)
//
// Each property draws from the shared `arrayOfUniformObjectsArbitrary` plus a
// local non-uniform array-of-objects generator so that missing keys / first-
// appearance column ordering are exercised (the uniform generator alone never
// produces absent cells). The oracles re-derive the expected behaviour from the
// same model the implementation sees, never by calling the implementation, so
// the tests are independent checks rather than tautologies.

import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from './types';
import { type Cell, type Grid, filterRows, sortRows, toGrid } from './grid';
import {
  arrayOfUniformObjectsArbitrary,
  edgyStringArbitrary,
  numberLexemeArbitrary,
} from '../../test/arbitraries';

// ─── Local generators: arrays of (possibly non-uniform) scalar objects ───────

/** A scalar `JsonNode` with placeholder id/key (id/key assigned when placed). */
function scalarNodeArbitrary(): fc.Arbitrary<JsonNode> {
  return fc.oneof(
    fc.constant<JsonNode>({ id: '', key: '', type: 'null' }),
    fc
      .boolean()
      .map<JsonNode>((v) => ({ id: '', key: '', type: 'boolean', boolValue: v })),
    edgyStringArbitrary().map<JsonNode>((v) => ({
      id: '',
      key: '',
      type: 'string',
      stringValue: v,
    })),
    numberLexemeArbitrary().map<JsonNode>((v) => ({
      id: '',
      key: '',
      type: 'number',
      numberValue: v,
    })),
  );
}

/** Build an object node from ordered `[key, scalarValue]` entries. */
function objectNode(
  parentId: string,
  index: number,
  entries: Array<[string, JsonNode]>,
): JsonNode {
  const id = `${parentId}/${index}`;
  return {
    id,
    key: index,
    type: 'object',
    children: entries.map(([key, value]) => ({
      ...value,
      id: `${id}/${encodeURIComponent(key)}`,
      key,
    })),
  };
}

/** Build the array-of-objects root node from per-row entry lists. */
function arrayOfObjectsNode(rows: Array<Array<[string, JsonNode]>>): JsonNode {
  return {
    id: '$',
    key: null,
    type: 'array',
    children: rows.map((entries, index) => objectNode('$', index, entries)),
  };
}

/**
 * An array of *non-uniform* scalar objects: each element draws a non-empty,
 * randomly-ordered subset of a shared key pool, so columns must be discovered
 * by first appearance and later rows are missing earlier keys (absent cells).
 */
function nonUniformArrayArbitrary(): fc.Arbitrary<JsonNode> {
  const keyPool = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), {
    minLength: 1,
    maxLength: 5,
  });

  return keyPool.chain((pool) => {
    const rowArbitrary = fc
      .shuffledSubarray(pool, { minLength: 1, maxLength: pool.length })
      .chain((keys) =>
        fc
          .tuple(...keys.map(() => scalarNodeArbitrary()))
          .map((values) =>
            keys.map((key, i): [string, JsonNode] => [key, values[i]]),
          ),
      );

    return fc
      .array(rowArbitrary, { minLength: 1, maxLength: 8 })
      .map((rows) => arrayOfObjectsNode(rows));
  });
}

/** Either a uniform (shared arbitrary) or non-uniform array of objects. */
function arrayOfObjectsArbitrary(): fc.Arbitrary<JsonNode> {
  return fc.oneof(arrayOfUniformObjectsArbitrary(), nonUniformArrayArbitrary());
}

// ─── Oracles (independent re-derivations) ────────────────────────────────────

/** The string value the grid uses for a scalar node (mirrors `cellValueString`). */
function scalarValueString(node: JsonNode): string {
  switch (node.type) {
    case 'string':
      return node.stringValue ?? '';
    case 'number':
      return node.numberValue ?? '0';
    case 'boolean':
      return node.boolValue ? 'true' : 'false';
    case 'null':
      return 'null';
    default:
      throw new Error(`unexpected non-scalar cell value: ${node.type}`);
  }
}

/** A comparable, structure-only projection of a grid (present flag + value). */
interface SimpleGrid {
  columns: string[];
  rows: Array<{
    index: number;
    cells: Record<string, { present: boolean; value?: string }>;
  }>;
}

/** Project a built grid to its comparable shape. */
function simplify(grid: Grid): SimpleGrid {
  return {
    columns: grid.columns,
    rows: grid.rows.map((row) => ({
      index: row.index,
      cells: Object.fromEntries(
        grid.columns.map((column) => {
          const cell = row.cells[column];
          return [
            column,
            cell.present ? { present: true, value: cell.value } : { present: false },
          ];
        }),
      ),
    })),
  };
}

/** Re-derive the expected grid directly from the source array-of-objects node. */
function expectedGrid(node: JsonNode): SimpleGrid {
  const elements = node.children ?? [];

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    for (const child of element.children ?? []) {
      const key = String(child.key);
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const rows = elements.map((element, index) => {
    const byKey = new Map<string, JsonNode>();
    for (const child of element.children ?? []) {
      const key = String(child.key);
      if (!byKey.has(key)) byKey.set(key, child);
    }
    const cells: SimpleGrid['rows'][number]['cells'] = {};
    for (const column of columns) {
      const child = byKey.get(column);
      cells[column] = child
        ? { present: true, value: scalarValueString(child) }
        : { present: false };
    }
    return { index, cells };
  });

  return { columns, rows };
}

/** Build a grid arbitrary (only `ok` grids) for the filter/sort properties. */
function gridArbitrary(): fc.Arbitrary<Grid> {
  return arrayOfObjectsArbitrary()
    .map((node) => toGrid(node))
    .filter((result): result is { ok: true; grid: Grid } => result.ok)
    .map((result) => result.grid)
    .filter((grid) => grid.columns.length >= 1);
}

// ─── Property 26 ─────────────────────────────────────────────────────────────

describe('Property 26: Grid construction mirrors the array (Req 15.1, 15.6)', () => {
  // Feature: json-viewer-free, Property 26: Grid construction mirrors the array
  // Validates: Requirements 15.1, 15.6
  test.prop([arrayOfObjectsArbitrary()], { numRuns: 100 })(
    'columns follow first appearance, rows follow array order, missing keys are empty cells',
    (node) => {
      const result = toGrid(node);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const expected = expectedGrid(node);

      // Columns: distinct keys ordered by first appearance across elements.
      expect(result.grid.columns).toEqual(expected.columns);

      // Rows: one per element, in array order (indices 0..n-1).
      expect(result.grid.rows.map((r) => r.index)).toEqual(
        (node.children ?? []).map((_, i) => i),
      );

      // Full mirror, including absent cells for keys missing from an element.
      expect(simplify(result.grid)).toEqual(expected);
    },
  );
});

// ─── Property 27 ─────────────────────────────────────────────────────────────

/** Whether a present cell's value contains `lowerTerm` (case-insensitive). */
function cellMatches(cell: Cell, lowerTerm: string): boolean {
  return cell.present && cell.value.toLowerCase().includes(lowerTerm);
}

/** Oracle: does a row satisfy every active predicate of the criteria? */
function rowSatisfies(
  grid: Grid,
  row: Grid['rows'][number],
  criteria: { search?: string; columnFilters?: Record<string, string> },
): boolean {
  const lowerSearch = (criteria.search ?? '').toLowerCase();
  if (lowerSearch.length >= 1) {
    const any = grid.columns.some((column) =>
      cellMatches(row.cells[column], lowerSearch),
    );
    if (!any) return false;
  }
  for (const [column, term] of Object.entries(criteria.columnFilters ?? {})) {
    if (term && term.length >= 1) {
      if (!cellMatches(row.cells[column], term.toLowerCase())) return false;
    }
  }
  return true;
}

describe('Property 27: Grid search and filter select exactly the matching rows (Req 15.2, 15.3, 15.4, 15.6)', () => {
  // A grid paired with search/column-filter criteria. Terms are biased toward
  // real substrings of present cell values (in mixed case, to exercise the
  // case-insensitive match) so matches are actually produced, plus empty and
  // random terms for the "matches all" / "matches none" boundaries.
  const gridWithCriteriaArbitrary = gridArbitrary().chain((grid) => {
    const present = new Set<string>();
    for (const row of grid.rows) {
      for (const column of grid.columns) {
        const cell = row.cells[column];
        if (cell.present && cell.value.length > 0) present.add(cell.value);
      }
    }
    const candidates = new Set<string>();
    for (const value of present) {
      candidates.add(value);
      if (value.length >= 2) {
        candidates.add(value.slice(0, Math.ceil(value.length / 2)));
        candidates.add(value.slice(1));
      }
    }
    const candidateArray = candidates.size > 0 ? [...candidates] : ['x'];

    const termArbitrary = fc.oneof(
      fc.constant(''), // empty search => matches all rows (Req 15.3)
      fc.constantFrom(...candidateArray),
      fc.constantFrom(...candidateArray).map((s) => s.toUpperCase()),
      fc.constantFrom(...candidateArray).map((s) => s.toLowerCase()),
      edgyStringArbitrary(),
    );

    const columnFiltersArbitrary = fc
      .array(fc.tuple(fc.constantFrom(...grid.columns), termArbitrary), {
        maxLength: grid.columns.length,
      })
      .map((pairs) => Object.fromEntries(pairs));

    return fc
      .record({ search: termArbitrary, columnFilters: columnFiltersArbitrary })
      .map((criteria) => ({ grid, criteria }));
  });

  // Feature: json-viewer-free, Property 27: Grid search and filter select exactly the matching rows
  // Validates: Requirements 15.2, 15.3, 15.4, 15.6
  test.prop([gridWithCriteriaArbitrary], { numRuns: 100 })(
    'displayed rows are exactly those satisfying every active predicate; empty cells never match',
    ({ grid, criteria }) => {
      const result = filterRows(grid, criteria);

      // Headers are always retained (Req 15.7).
      expect(result.columns).toEqual(grid.columns);

      // Exactly the rows satisfying the predicate, in original order.
      const expected = grid.rows.filter((row) =>
        rowSatisfies(grid, row, criteria),
      );
      expect(result.rows.map((r) => r.index)).toEqual(
        expected.map((r) => r.index),
      );

      // Every surviving row genuinely satisfies the predicate (absent cells
      // never carry a match).
      for (const row of result.rows) {
        expect(rowSatisfies(grid, row, criteria)).toBe(true);
      }
    },
  );
});

// ─── Property 28 ─────────────────────────────────────────────────────────────

/** Ascending cell comparison (mirrors `compareCellsAsc` in grid.ts). */
function compareCellsAsc(a: Cell, b: Cell): number {
  if (!a.present && !b.present) return 0;
  if (!a.present) return 1; // absent after present
  if (!b.present) return -1;

  if (a.type === 'number' && b.type === 'number') {
    const an = Number(a.value);
    const bn = Number(b.value);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
      return an < bn ? -1 : 1;
    }
  }
  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return 0;
}

describe('Property 28: Grid sort orders ascending then toggles to descending (Req 15.5)', () => {
  const gridWithColumnArbitrary = gridArbitrary().chain((grid) =>
    fc.constantFrom(...grid.columns).map((column) => ({ grid, column })),
  );

  // Feature: json-viewer-free, Property 28: Grid sort orders ascending then toggles to descending
  // Validates: Requirements 15.5
  test.prop([gridWithColumnArbitrary], { numRuns: 100 })(
    'ascending sort is non-decreasing and a second activation is its exact reverse',
    ({ grid, column }) => {
      const asc = sortRows(grid, column, 'asc');
      const desc = sortRows(grid, column, 'desc');

      // Columns retained on both.
      expect(asc.columns).toEqual(grid.columns);
      expect(desc.columns).toEqual(grid.columns);

      // Both sorts are permutations of the original rows.
      const originalIndices = [...grid.rows.map((r) => r.index)].sort((a, b) => a - b);
      expect([...asc.rows.map((r) => r.index)].sort((a, b) => a - b)).toEqual(
        originalIndices,
      );
      expect([...desc.rows.map((r) => r.index)].sort((a, b) => a - b)).toEqual(
        originalIndices,
      );

      // Ascending: adjacent rows are non-decreasing by the column comparator.
      for (let i = 0; i + 1 < asc.rows.length; i++) {
        const cmp = compareCellsAsc(
          asc.rows[i].cells[column],
          asc.rows[i + 1].cells[column],
        );
        expect(cmp).toBeLessThanOrEqual(0);
      }

      // Descending is the exact reverse of ascending.
      expect(desc.rows.map((r) => r.index)).toEqual(
        [...asc.rows].reverse().map((r) => r.index),
      );
    },
  );
});
