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
import { $document, setDocumentText } from '../../lib/stores/document';
import { serialize } from '../../lib/json-core/serialize';
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
const MIN_COLUMN_WIDTH = 120;

/** Default starting width, in pixels, for each column (resizable by the user). */
const DEFAULT_COLUMN_WIDTH = 220;

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

/** The download formats offered for the current (filtered/sorted) grid view. */
type DownloadFormat = 'json' | 'csv';

/**
 * Serialize the current grid view (already filtered and sorted) back into a
 * JSON array of objects, preserving each value's real type via the underlying
 * node. Absent cells are omitted from their row's object.
 */
function gridViewToJson(view: Grid): string {
  const objects = view.rows.map((row) => {
    const parts = view.columns
      .map((column) => {
        const cell = row.cells[column];
        if (!cell.present) return null;
        return `${JSON.stringify(column)}:${serialize(cell.node)}`;
      })
      .filter((part): part is string => part !== null);
    return `{${parts.join(',')}}`;
  });
  const text = `[${objects.join(',')}]`;
  // Pretty-print when the assembled text is valid JSON (it always should be).
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Quote a CSV field when it contains a comma, quote, or newline (RFC 4180). */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize the current grid view to CSV: a header row of column names followed
 * by one row per visible record. Absent cells render as empty fields.
 */
function gridViewToCsv(view: Grid): string {
  const header = view.columns.map(csvField).join(',');
  const lines = view.rows.map((row) =>
    view.columns.map((column) => csvField(cellText(row.cells[column]))).join(','),
  );
  return [header, ...lines].join('\r\n');
}

/** Trigger a client-side file download of `content` (no network involved). */
function triggerDownload(filename: string, content: string, mime: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
  // Per-column pixel widths, adjusted by dragging the column dividers.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  // Selected export format for downloading the current (filtered/sorted) view.
  const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>('json');

  /**
   * Begin a column-resize drag from the divider on a header's right edge.
   * Tracks the pointer and updates the column's width (clamped to a minimum)
   * until the pointer is released.
   */
  const startColumnResize = (column: string, event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[column] ?? DEFAULT_COLUMN_WIDTH;
    const onMove = (move: PointerEvent) => {
      const next = Math.max(MIN_COLUMN_WIDTH, startWidth + (move.clientX - startX));
      setColumnWidths((prev) => ({ ...prev, [column]: next }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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

  // Not an array of objects (or no document yet): a paste box so the user can
  // load data right here, plus the reason message (Req 15.8). The textarea is
  // synced to the shared document, so pasting here also populates the Viewer.
  if (!result || !result.ok || !view) {
    const reason =
      result && !result.ok
        ? result.reason
        : 'The grid view requires an array of objects.';
    const hasText = doc.text.trim() !== '';
    return (
      <section
        aria-label="Table Grid panel"
        data-tool-panel="grid"
        class="min-h-0 flex-1 overflow-auto p-lg"
      >
        <div class="flex w-full flex-col gap-md rounded-lg border border-hairline bg-canvas-soft p-lg shadow-level-1">
          <div class="flex flex-wrap items-center justify-between gap-sm">
            <h2 class="font-sans text-display-sm text-ink">Table Grid</h2>
          </div>
          <p class="font-sans text-body-sm text-body break-words">
            Paste a{' '}
            <span class="font-sans text-body-sm-strong text-ink">
              JSON array of objects
            </span>{' '}
            below to see it as a sortable, searchable table. Each object becomes a
            row, and the keys become columns.
          </p>
          <textarea
            class="h-[38vh] min-h-[12rem] w-full resize-y rounded-md border border-hairline bg-canvas p-3 font-mono text-code leading-relaxed text-ink outline-none transition-colors placeholder:text-mute focus:border-link focus:ring-1 focus:ring-link"
            data-input="grid-json"
            spellcheck={false}
            placeholder={'[\n  { "id": 1, "name": "Ada" },\n  { "id": 2, "name": "Linus" }\n]'}
            value={doc.text}
            onInput={(e) =>
              setDocumentText((e.currentTarget as HTMLTextAreaElement).value)
            }
          />
          {hasText ? (
            <p
              class="flex items-center gap-1.5 font-sans text-body-sm text-error"
              data-status="grid-empty-reason"
              role="status"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.25" />
                <line x1="8" y1="4.75" x2="8" y2="8.75" />
                <line x1="8" y1="11" x2="8" y2="11.25" />
              </svg>
              {reason}
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  const { columns } = view;
  const gridTemplateColumns = columns
    .map((column) => `${columnWidths[column] ?? DEFAULT_COLUMN_WIDTH}px`)
    .join(' ');
  const noRows = view.rows.length === 0;

  const onColumnFilter = (column: string, term: string) => {
    setColumnFilters((prev) => ({ ...prev, [column]: term }));
  };

  // Download the current view (already filtered + sorted) in the chosen format.
  const onDownload = () => {
    const isCsv = downloadFormat === 'csv';
    const content = isCsv ? gridViewToCsv(view) : gridViewToJson(view);
    triggerDownload(
      `table-grid.${isCsv ? 'csv' : 'json'}`,
      content,
      isCsv ? 'text/csv;charset=utf-8' : 'application/json',
    );
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
          class="min-w-0 flex-1 bg-transparent px-xs py-xxs text-body-sm text-body focus:outline-none"
          onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
        />
        <span class="shrink-0 text-caption text-mute">
          {view.rows.length} {view.rows.length === 1 ? 'row' : 'rows'}
        </span>
        {/* Download the current filtered/sorted rows in the chosen format. */}
        <label class="sr-only" for="grid-download-format">
          Download format
        </label>
        <select
          id="grid-download-format"
          data-control="download-format"
          class="shrink-0 rounded-sm px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline focus:outline-none focus:ring-link"
          value={downloadFormat}
          onChange={(e) =>
            setDownloadFormat((e.currentTarget as HTMLSelectElement).value as DownloadFormat)
          }
        >
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
        </select>
        <button
          type="button"
          data-action="download"
          class="shrink-0 rounded-sm bg-primary px-3 py-1.5 font-sans text-button-md text-on-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50"
          title="Download the current filtered/sorted rows"
          onClick={onDownload}
        >
          Download
        </button>
        <button
          type="button"
          data-action="load-new-json"
          class="shrink-0 rounded-sm px-sm py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
          title="Clear the current data and paste new JSON"
          onClick={() => setDocumentText('')}
        >
          Load new JSON
        </button>
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
                  class="relative flex items-center gap-xs border-r border-hairline px-xs py-xs last:border-r-0"
                >
                  <button
                    type="button"
                    class="flex min-w-0 shrink-0 items-center gap-xs truncate text-left text-body-sm-strong text-ink hover:text-link"
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
                    class="min-w-0 flex-1 rounded-xs px-xs py-xxs text-caption text-body ring-1 ring-inset ring-hairline focus:outline-none focus:ring-link"
                    onInput={(e) =>
                      onColumnFilter(column, (e.currentTarget as HTMLInputElement).value)
                    }
                  />
                  {/* Draggable divider to resize this column. */}
                  <div
                    class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-link/40"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column} column`}
                    onPointerDown={(e) => startColumnResize(column, e as unknown as PointerEvent)}
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
