/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 15.1
//
// GridPanel: the Table Grid tool (Req 15). A virtualized table rendered over
// the pure grid transforms in `lib/json-core/grid.ts`:
//
//   toGrid(model)              — JsonNode -> Grid (or a not-an-array reason)
//   filterRows(grid, criteria) — global search + per-column filters
//   sortRows(grid, col, dir)   — ascending / descending sort
//
// Responsibilities owned here (the data logic lives in grid.ts and is unit/
// property tested there):
//
//   • Read the shared parsed document from `$document` and build the base grid
//     (Req 15.1). When the top-level value is not an array of objects, render a
//     message and no rows (Req 15.8).
//   • A global search input that keeps rows with any matching cell (Req 15.2)
//     and shows every row again once cleared (Req 15.3).
//   • A per-column filter input under each header (Req 15.4), composed with the
//     active search term.
//   • A sort toggle on each column header: first activation sorts ascending,
//     re-activating the same column sorts descending (Req 15.5).
//   • Empty (absent) cells for keys an element lacks (Req 15.1, 15.6) — these
//     are produced by `toGrid` and never match search/filter.
//   • A "no matching rows" message that retains the column headers when the
//     active criteria exclude every row (Req 15.7).
//
// Rows are windowed with `@tanstack/virtual-core` (the same framework-agnostic
// Virtualizer used by TreePanel) so a large array of objects renders only the
// on-screen rows.

import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '@nanostores/preact';
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from '@tanstack/virtual-core';
import { $document } from '../../lib/stores/document';
import {
  toGrid,
  filterRows,
  sortRows,
  type Cell,
  type Grid,
  type SortDirection,
} from '../../lib/json-core/grid';

/** Estimated pixel height of a single grid row; drives the virtual window. */
export const ROW_HEIGHT = 36;

/** Number of extra rows rendered above/below the viewport for smooth scroll. */
const OVERSCAN = 12;

/** Minimum on-screen width, in pixels, allotted to each column. */
const MIN_COLUMN_WIDTH = 180;

/** The current sort selection: a column plus a direction, or none. */
interface SortState {
  column: string;
  direction: SortDirection;
}

/**
 * Preact binding for the framework-agnostic `@tanstack/virtual-core`
 * `Virtualizer` (identical in shape to the one in TreePanel): construct once,
 * keep options in sync each render, wire its lifecycle to layout effects, and
 * force a re-render whenever the virtualizer reports a change.
 */
function useVirtualizer(
  count: number,
  getScrollElement: () => HTMLElement | null,
): Virtualizer<HTMLElement, Element> {
  const [, setTick] = useState(0);
  const forceRender = () => setTick((n) => n + 1);

  const virtualizer = useState(
    () =>
      new Virtualizer<HTMLElement, Element>({
        count,
        getScrollElement,
        estimateSize: () => ROW_HEIGHT,
        overscan: OVERSCAN,
        scrollToFn: elementScroll,
        observeElementRect,
        observeElementOffset,
        onChange: () => forceRender(),
      }),
  )[0];

  virtualizer.setOptions({
    ...virtualizer.options,
    count,
    getScrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => forceRender(),
  });

  useLayoutEffect(() => virtualizer._didMount(), []);
  useLayoutEffect(() => {
    virtualizer._willUpdate();
  });

  return virtualizer;
}

/** A short, display-ready rendering of a single cell's value. */
function cellText(cell: Cell): string {
  return cell.present ? cell.value : '';
}

/**
 * Next sort state when a column header is activated (Req 15.5): a column that is
 * not currently sorted starts ascending; re-activating the ascending column
 * flips it to descending; re-activating the descending column returns to
 * ascending.
 */
function nextSort(current: SortState | null, column: string): SortState {
  if (current?.column === column && current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return { column, direction: 'asc' };
}

/** The sort indicator shown in a column header for the active sort column. */
function sortIndicator(sort: SortState | null, column: string): string {
  if (sort?.column !== column) return '';
  return sort.direction === 'asc' ? ' ▲' : ' ▼';
}

/** Props for {@link GridPanel}. */
export interface GridPanelProps {
  /**
   * Optional override of the grid built from the shared document. Primarily for
   * tests/stories; when omitted the panel derives the grid from `$document`.
   */
  gridResult?: ReturnType<typeof toGrid> | null;
}

/**
 * The Table Grid tool. Builds the grid from the shared document, then applies
 * the active search/column-filter/sort selections via the pure grid transforms
 * and renders the result as a virtualized table.
 */
export default function GridPanel({ gridResult }: GridPanelProps = {}) {
  const doc = useStore($document);

  const [search, setSearch] = useState('');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | null>(null);

  // Build the base grid from the shared parsed document (or the override).
  const result = useMemo(() => {
    if (gridResult) return gridResult;
    const { parsed } = doc;
    if (!parsed.ok || parsed.empty || parsed.model == null) return null;
    return toGrid(parsed.model);
  }, [gridResult, doc]);

  // Apply filters then sort. Memoized so scrolling/re-render does not recompute.
  const view: Grid | null = useMemo(() => {
    if (!result || !result.ok) return null;
    const filtered = filterRows(result.grid, { search, columnFilters });
    return sort ? sortRows(filtered, sort.column, sort.direction) : filtered;
  }, [result, search, columnFilters, sort]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowCount = view?.rows.length ?? 0;
  const virtualizer = useVirtualizer(rowCount, () => scrollRef.current);
  const virtualItems = virtualizer.getVirtualItems();

  // Not an array of objects (or no document yet): message, no rows (Req 15.8).
  if (!result || !result.ok || !view) {
    const message =
      result && !result.ok
        ? result.reason
        : 'The grid view requires an array of objects.';
    return (
      <section aria-label="Table Grid panel" data-tool-panel="grid" class="flex min-h-0 flex-1 flex-col">
        <div class="flex h-full items-center justify-center p-xl text-body-sm text-mute">
          {message}
        </div>
      </section>
    );
  }

  const { columns } = view;
  const gridTemplateColumns = `repeat(${columns.length}, minmax(${MIN_COLUMN_WIDTH}px, 1fr))`;
  const noRows = view.rows.length === 0;

  const onColumnFilter = (column: string, term: string) => {
    setColumnFilters((prev) => ({ ...prev, [column]: term }));
  };

  return (
    <section aria-label="Table Grid panel" data-tool-panel="grid" class="flex min-h-0 flex-1 flex-col">
      {/* Global search (Req 15.2 / 15.3) */}
      <div class="flex items-center gap-sm border-b border-hairline px-sm py-xs">
        <input
          type="search"
          value={search}
          placeholder="Search all columns…"
          aria-label="Search all columns"
          class="min-w-0 flex-1 rounded-xs px-xs py-xxs text-body-sm text-body ring-1 ring-inset ring-hairline focus:outline-none focus:ring-link"
          onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
        />
        <span class="shrink-0 text-caption text-mute">
          {view.rows.length} {view.rows.length === 1 ? 'row' : 'rows'}
        </span>
      </div>

      {/* Scroll container: sticky header + virtualized body share one scroller. */}
      <div ref={scrollRef} class="relative min-h-0 flex-1 overflow-auto">
        <div class="relative" style={{ minWidth: 'max-content' }}>
          {/* Column headers: sort toggle (Req 15.5) + per-column filter (Req 15.4). */}
          <div
            role="row"
            class="sticky top-0 z-10 grid border-b border-hairline bg-canvas"
            style={{ gridTemplateColumns }}
          >
            {columns.map((column) => {
              const active = sort?.column === column;
              return (
                <div
                  key={column}
                  role="columnheader"
                  class="flex flex-col gap-xxs border-r border-hairline px-xs py-xs last:border-r-0"
                >
                  <button
                    type="button"
                    class="flex items-center justify-between gap-xs truncate text-left text-body-sm-strong text-ink hover:text-link"
                    aria-label={`Sort by ${column}`}
                    aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    onClick={() => setSort((prev) => nextSort(prev, column))}
                  >
                    <span class="truncate">{column}</span>
                    <span class="shrink-0 text-mute">{sortIndicator(sort, column) || '↕'}</span>
                  </button>
                  <input
                    type="search"
                    value={columnFilters[column] ?? ''}
                    placeholder="Filter…"
                    aria-label={`Filter ${column}`}
                    class="min-w-0 rounded-xs px-xs py-xxs text-caption text-body ring-1 ring-inset ring-hairline focus:outline-none focus:ring-link"
                    onInput={(e) =>
                      onColumnFilter(column, (e.currentTarget as HTMLInputElement).value)
                    }
                  />
                </div>
              );
            })}
          </div>

          {/* No matching rows: keep headers above, show a message (Req 15.7). */}
          {noRows ? (
            <div class="p-xl text-center text-body-sm text-mute">
              No rows match the current criteria.
            </div>
          ) : (
            <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              {virtualItems.map((vi) => {
                const row = view.rows[vi.index];
                if (!row) return null;
                return (
                  <div
                    key={row.index}
                    role="row"
                    data-index={vi.index}
                    class="absolute left-0 top-0 grid w-full border-b border-hairline hover:bg-canvas-soft"
                    style={{
                      gridTemplateColumns,
                      height: `${vi.size}px`,
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {columns.map((column) => {
                      const cell = row.cells[column];
                      return (
                        <div
                          key={column}
                          role="cell"
                          class="truncate border-r border-hairline px-xs py-xs font-mono text-code text-body last:border-r-0"
                          title={cellText(cell)}
                        >
                          {/* Absent cells render empty (Req 15.6). */}
                          {cellText(cell)}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
