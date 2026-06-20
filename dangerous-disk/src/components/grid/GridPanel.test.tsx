/** @jsxImportSource preact */
// Feature: json-viewer-free — GridPanel UI unit tests (Task 15.2)
//
// Validates: Requirements 15.7, 15.8
//
// GridPanel is the Table Grid tool. It builds a grid from the shared `$document`
// (via `toGrid`) and applies the active search / column filters / sort using the
// pure transforms in `lib/json-core/grid.ts`. These tests drive the shared
// document with `setDocumentText` (the same path the editor uses), render the
// panel into a jsdom container with preact `render`, and assert the two
// "edge" surfaces this task covers:
//
//   Req 15.7: when an active search (or column filter) excludes every row, the
//             panel shows the "no rows match" message AND keeps all column
//             headers rendered (the headers are retained, not torn down).
//   Req 15.8: when the top-level value is not an array of objects, the panel
//             shows the "grid view requires an array of objects" message and
//             renders no table rows (no row/cell elements at all).
//
// The data logic itself is unit/property tested in grid.ts; here we only assert
// the rendered panel reflects those two states.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { setDocumentText } from '../../lib/stores/document';
import GridPanel from './GridPanel';

let container: HTMLDivElement;

beforeEach(() => {
  setDocumentText('');
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  // Unmount and detach so the store subscription is torn down between tests.
  render(null, container);
  container.remove();
  setDocumentText('');
});

/** Set the shared document then mount a fresh GridPanel reflecting it. */
function mountWith(text: string): void {
  setDocumentText(text);
  render(<GridPanel />, container);
}

/** The column header labels currently rendered, in document order. */
function headerLabels(): string[] {
  return Array.from(container.querySelectorAll('[role="columnheader"]')).map(
    (el) => el.querySelector('button span')?.textContent ?? '',
  );
}

/**
 * Type `term` into the global search input and let preact's state-driven
 * re-render settle. preact flushes setState asynchronously, so we await a
 * macrotask after dispatching the input event before assertions run.
 */
async function typeSearch(term: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search all columns"]',
  );
  if (!input) throw new Error('expected a global search input');
  input.value = term;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The "N row(s)" count shown next to the search box. */
function rowCountText(): string {
  return (
    container.querySelector('[data-tool-panel="grid"] span.text-caption')
      ?.textContent ?? ''
  );
}

const NO_MATCH_MESSAGE = 'No rows match the current criteria.';

describe('GridPanel no-matching-rows retains headers (Req 15.7)', () => {
  // An array of objects with two columns so we have headers to retain.
  // NOTE: virtualized data rows are not painted under jsdom (no layout), so
  // these tests assert on the headers, the row-count readout, and the
  // no-matching-rows message rather than on the virtualized row cells.
  const arrayOfObjects = JSON.stringify([
    { name: 'Ada', role: 'engineer' },
    { name: 'Linus', role: 'maintainer' },
  ]);

  it('renders headers and no message before any filter is active', () => {
    mountWith(arrayOfObjects);

    expect(headerLabels()).toEqual(['name', 'role']);
    expect(rowCountText()).toContain('2 rows');
    expect(container.textContent).not.toContain(NO_MATCH_MESSAGE);
  });

  it('shows the no-matching-rows message when a search excludes every row', async () => {
    mountWith(arrayOfObjects);

    await typeSearch('zzz-no-such-value-zzz');

    expect(container.textContent).toContain(NO_MATCH_MESSAGE);
    // The count reflects that the active search left zero rows.
    expect(rowCountText()).toContain('0 rows');
  });

  it('retains all column headers while the no-matching-rows message is shown', async () => {
    mountWith(arrayOfObjects);

    await typeSearch('zzz-no-such-value-zzz');

    // The message is shown, yet the headers are still present and complete.
    expect(container.textContent).toContain(NO_MATCH_MESSAGE);
    expect(headerLabels()).toEqual(['name', 'role']);
  });

  it('restores the rows when the excluding search term is cleared (Req 15.3 surface)', async () => {
    mountWith(arrayOfObjects);

    await typeSearch('zzz-no-such-value-zzz');
    expect(container.textContent).toContain(NO_MATCH_MESSAGE);

    await typeSearch('');
    expect(container.textContent).not.toContain(NO_MATCH_MESSAGE);
    expect(rowCountText()).toContain('2 rows');
    expect(headerLabels()).toEqual(['name', 'role']);
  });
});

describe('GridPanel not-an-array-of-objects message renders no rows (Req 15.8)', () => {
  const NOT_ARRAY_MESSAGE = 'The grid view requires an array of objects.';

  it('shows the message and no rows for a top-level object', () => {
    mountWith('{"name":"Ada"}');

    expect(container.textContent).toContain(NOT_ARRAY_MESSAGE);
    expect(container.querySelectorAll('[role="row"]').length).toBe(0);
    expect(container.querySelectorAll('[role="cell"]').length).toBe(0);
    expect(container.querySelectorAll('[role="columnheader"]').length).toBe(0);
  });

  it('shows the message and no rows for an array of scalars', () => {
    mountWith('[1, 2, 3]');

    expect(container.textContent).toContain(NOT_ARRAY_MESSAGE);
    expect(container.querySelectorAll('[role="row"]').length).toBe(0);
    expect(container.querySelectorAll('[role="cell"]').length).toBe(0);
  });

  it('shows the message and no rows for an array mixing objects and non-objects', () => {
    mountWith('[{"a":1}, 7]');

    expect(container.textContent).toContain(NOT_ARRAY_MESSAGE);
    expect(container.querySelectorAll('[role="row"]').length).toBe(0);
    expect(container.querySelectorAll('[role="cell"]').length).toBe(0);
  });
});
