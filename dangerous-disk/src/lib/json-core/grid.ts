// Feature: json-viewer-free
//
// Grid transforms for the Table Grid tool (Req 15). Three pure, DOM-free
// functions operate over the `JsonNode` model:
//
//   toGrid(model)                  : JsonNode -> ToGridResult
//   filterRows(grid, criteria)     : Grid     -> Grid
//   sortRows(grid, column, dir)    : Grid     -> Grid
//
// The grid is a column/row view of an array of objects:
//   - columns are the distinct object keys, ordered by first appearance across
//     all elements (Req 15.1),
//   - rows correspond one-to-one to array elements, in array order (Req 15.1),
//   - a key missing from an element renders as an *absent* cell, which is held
//     distinct from a present `null`/empty-string value and is treated as a
//     non-match for every search and filter (Req 15.6).
//
// `toGrid` returns a discriminated result so the GridPanel can show the
// "requires an array of objects" message when the input is not an array of
// objects (Req 15.8). `filterRows`/`sortRows` are total transforms over a
// `Grid` and always retain the column headers (Req 15.7).

import type { JsonNode, JsonType } from './types';
import { serialize } from './serialize';

/**
 * A single grid cell.
 *
 * Absence is represented explicitly (`{ present: false }`) so a key that is
 * missing from an element is distinguishable from a key whose value is `null`
 * or an empty string. Absent cells never match a search or filter (Req 15.6).
 */
export type Cell = PresentCell | AbsentCell;

/** A cell backed by an actual value in the source element. */
export interface PresentCell {
  present: true;
  /** The underlying node, for rendering (type badge, rich media, etc.). */
  node: JsonNode;
  /** The JSON type of the value. */
  type: JsonType;
  /**
   * The cell's string value, used for search, column filtering, and sorting.
   * Scalars use their natural text (string contents, number lexeme,
   * `true`/`false`, `null`); objects/arrays use their compact JSON text.
   */
  value: string;
}

/** A cell for a key that the element does not contain. */
export interface AbsentCell {
  present: false;
}

/** One grid row, mapped from a single array element. */
export interface Row {
  /** The element's 0-based index in the source array (array order). */
  index: number;
  /** Cells keyed by column name; every column has an entry. */
  cells: Record<string, Cell>;
}

/** A tabular view of an array of objects. */
export interface Grid {
  /** Distinct object keys, ordered by first appearance across elements. */
  columns: string[];
  /** One row per array element, in array order. */
  rows: Row[];
}

/** Result of {@link toGrid}: either a built grid or a reason it is not buildable. */
export type ToGridResult =
  | { ok: true; grid: Grid }
  | { ok: false; reason: string };

/** Filter criteria for {@link filterRows}. */
export interface FilterCriteria {
  /**
   * Global search term. Empty/undefined applies no global constraint; a term of
   * 1+ characters keeps rows with any present cell whose value contains the term
   * as a case-insensitive substring (Req 15.2, 15.3).
   */
  search?: string;
  /**
   * Per-column filter terms keyed by column name. A non-empty term keeps rows
   * whose cell in that column is present and contains the term as a
   * case-insensitive substring; empty terms apply no constraint (Req 15.4).
   */
  columnFilters?: Record<string, string>;
}

/** Sort direction for {@link sortRows}. */
export type SortDirection = 'asc' | 'desc';

/**
 * The string value used for search/filter/sort of a present cell. Scalars use
 * their natural text; containers use compact JSON so they remain searchable.
 */
function cellValueString(node: JsonNode): string {
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
      // object / array: compact JSON text.
      return serialize(node);
  }
}

/**
 * Build a {@link Grid} from a {@link JsonNode}.
 *
 * The input must be an array whose every element is an object (an empty array
 * is accepted and yields an empty grid). Otherwise a `{ ok: false, reason }`
 * result is returned so the caller can render the "requires an array of
 * objects" message (Req 15.8).
 *
 * Columns are the distinct object keys ordered by first appearance across
 * elements; rows preserve array order; keys missing from an element become
 * absent cells (Req 15.1, 15.6).
 */
export function toGrid(model: JsonNode): ToGridResult {
  if (model.type !== 'array') {
    return { ok: false, reason: 'The grid view requires an array of objects.' };
  }

  const elements = model.children ?? [];
  for (const element of elements) {
    if (element.type !== 'object') {
      return {
        ok: false,
        reason: 'The grid view requires an array of objects.',
      };
    }
  }

  // Columns ordered by first appearance across all elements.
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

  // One row per element, in array order; missing keys become absent cells.
  const rows: Row[] = elements.map((element, index) => {
    const byKey = new Map<string, JsonNode>();
    for (const child of element.children ?? []) {
      // First occurrence wins if an object somehow repeats a key.
      const key = String(child.key);
      if (!byKey.has(key)) {
        byKey.set(key, child);
      }
    }

    const cells: Record<string, Cell> = {};
    for (const column of columns) {
      const node = byKey.get(column);
      cells[column] = node
        ? { present: true, node, type: node.type, value: cellValueString(node) }
        : { present: false };
    }

    return { index, cells };
  });

  return { ok: true, grid: { columns, rows } };
}

/** True when a present cell's value contains `term` as a case-insensitive substring. */
function cellContains(cell: Cell, lowerTerm: string): boolean {
  if (!cell.present) {
    return false; // absent cells never match (Req 15.6)
  }
  return cell.value.toLowerCase().includes(lowerTerm);
}

/**
 * Filter a grid's rows by an optional global search term and per-column filters
 * (Req 15.2–15.4, 15.6). Columns are always retained (Req 15.7). A row is kept
 * only when it satisfies every active predicate:
 *   - the global search matches a row with any present cell whose value contains
 *     the term (an empty/absent search matches all rows), and
 *   - each active column filter matches that row's cell in the named column.
 * Absent (empty) cells never match.
 */
export function filterRows(grid: Grid, criteria: FilterCriteria): Grid {
  const search = criteria.search ?? '';
  const lowerSearch = search.toLowerCase();
  const hasSearch = lowerSearch.length >= 1;

  // Active per-column filters (non-empty terms only), pre-lowercased.
  const activeFilters: Array<{ column: string; lowerTerm: string }> = [];
  if (criteria.columnFilters) {
    for (const [column, term] of Object.entries(criteria.columnFilters)) {
      if (term && term.length >= 1) {
        activeFilters.push({ column, lowerTerm: term.toLowerCase() });
      }
    }
  }

  if (!hasSearch && activeFilters.length === 0) {
    return { columns: grid.columns, rows: grid.rows.slice() };
  }

  const rows = grid.rows.filter((row) => {
    // Global search: any cell matches.
    if (hasSearch) {
      const anyMatch = grid.columns.some((column) =>
        cellContains(row.cells[column], lowerSearch),
      );
      if (!anyMatch) {
        return false;
      }
    }
    // Column filters: the named column's cell must match.
    for (const { column, lowerTerm } of activeFilters) {
      if (!cellContains(row.cells[column], lowerTerm)) {
        return false;
      }
    }
    return true;
  });

  return { columns: grid.columns, rows };
}

/**
 * Ascending comparison of two cells for a column (Req 15.5).
 *
 * Ordering rules:
 *   - absent cells sort after every present cell (they sink to the bottom in
 *     ascending order, and — since descending is the exact reverse — rise to the
 *     top in descending order),
 *   - two numeric cells compare numerically,
 *   - all other pairs compare by their string value lexicographically.
 */
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
    // Fall through to lexicographic compare for equal/non-finite numbers.
  }

  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return 0;
}

/**
 * Sort a grid's rows by a column's values (Req 15.5).
 *
 * The ascending order is produced by a stable comparison; descending is the
 * exact reverse of that ascending order, so toggling sort on the same column
 * flips the order deterministically. Columns are retained unchanged.
 */
export function sortRows(
  grid: Grid,
  columnKey: string,
  direction: SortDirection,
): Grid {
  const ascending = grid.rows
    .slice()
    .sort((rowA, rowB) =>
      compareCellsAsc(rowA.cells[columnKey], rowB.cells[columnKey]),
    );

  const rows = direction === 'desc' ? ascending.reverse() : ascending;
  return { columns: grid.columns, rows };
}
