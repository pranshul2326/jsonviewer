/** @jsxImportSource preact */
// Feature: json-viewer-free — QueryPanel unit tests (Task 16.3)
//
// Validates: Requirements 16.4, 16.5, 16.7
//
// QueryPanel evaluates a JSONPath / JMESPath expression against the shared JSON
// document by dispatching to a worker. These tests inject a fake query runner
// (the `query` prop) so the panel's orchestration is exercised without a real
// `Worker`, and assert:
//
//   • Mode selection forwards the chosen mode and the expression/document to
//     the runner and renders the match set.
//   • A zero-match evaluation shows a clear no-results indicator (Req 16.4).
//   • The Copy control copies the complete result set and shows a confirmation
//     on success (Req 16.5) and a copy-failed message — while retaining the
//     results — on failure (Req 16.7).
//   • An invalid/empty-expression error is surfaced (with character position)
//     and the previously displayed results are left unchanged (Req 16.3, 16.6).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { setDocumentText } from '../../lib/stores/document';
import type { QueryResult } from '../../lib/query/engine';
import QueryPanel, { type QueryFn, type QueryPayload } from './QueryPanel';

let container: HTMLDivElement;

beforeEach(() => {
  setDocumentText('');
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  setDocumentText('');
  vi.restoreAllMocks();
});

/** Let Preact flush a batched re-render and settle the runner promise. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
const expressionInput = () =>
  container.querySelector<HTMLInputElement>('#query-expression')!;
const results = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Query results"]');
const runButton = () => button('Run')!;

function setExpression(value: string): void {
  const input = expressionInput();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('QueryPanel evaluation (mode + document forwarding)', () => {
  it('dispatches the selected mode/expression/document and renders the match set', async () => {
    setDocumentText('{"a":[1,2,3]}');
    const calls: QueryPayload[] = [];
    const query: QueryFn = (payload) => {
      calls.push(payload);
      return Promise.resolve<QueryResult>({ ok: true, results: [1, 2, 3] });
    };

    render(<QueryPanel query={query} />, container);

    setExpression('$.a[*]');
    await tick();
    runButton().click();
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      text: '{"a":[1,2,3]}',
      expression: '$.a[*]',
      mode: 'jsonpath',
    });
    expect(results()?.value).toBe(JSON.stringify([1, 2, 3], null, 2));
  });

  it('forwards the JMESPath mode when selected', async () => {
    setDocumentText('{"a":1}');
    const calls: QueryPayload[] = [];
    const query: QueryFn = (payload) => {
      calls.push(payload);
      return Promise.resolve<QueryResult>({ ok: true, results: [1] });
    };

    render(<QueryPanel query={query} />, container);

    button('JMESPath')!.click();
    await tick();
    setExpression('a');
    runButton().click();
    await tick();

    expect(calls.at(-1)?.mode).toBe('jmespath');
  });
});

describe('QueryPanel no-results indicator (Req 16.4)', () => {
  it('shows a clear no-results indicator when the evaluation matches nothing', async () => {
    setDocumentText('{"a":1}');
    const query: QueryFn = () => Promise.resolve<QueryResult>({ ok: true, results: [] });

    render(<QueryPanel query={query} />, container);

    setExpression('$.missing');
    runButton().click();
    await tick();

    const indicator = container.querySelector('[role="status"]');
    expect(indicator?.textContent).toContain('No results');
    // The results textarea is replaced by the indicator, and no Copy control is offered.
    expect(results()).toBeNull();
    expect(button('Copy')).toBeUndefined();
  });
});

describe('QueryPanel copy results (Req 16.5, 16.7)', () => {
  it('copies the complete result set and shows a confirmation on success', async () => {
    setDocumentText('{"a":[1,2]}');
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const query: QueryFn = () => Promise.resolve<QueryResult>({ ok: true, results: [1, 2] });
    render(<QueryPanel query={query} />, container);

    setExpression('$.a[*]');
    runButton().click();
    await tick();

    button('Copy')!.click();
    await tick();

    expect(writeText).toHaveBeenCalledWith(JSON.stringify([1, 2], null, 2));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('copied');
  });

  it('shows a copy-failed message and retains the results on failure', async () => {
    setDocumentText('{"a":[1,2]}');
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const query: QueryFn = () => Promise.resolve<QueryResult>({ ok: true, results: [1, 2] });
    render(<QueryPanel query={query} />, container);

    setExpression('$.a[*]');
    runButton().click();
    await tick();

    button('Copy')!.click();
    await tick();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Copy did not complete');
    // Results are retained.
    expect(results()?.value).toBe(JSON.stringify([1, 2], null, 2));
  });
});

describe('QueryPanel invalid/empty expression (Req 16.3, 16.6)', () => {
  it('surfaces a located error and leaves previously displayed results unchanged', async () => {
    setDocumentText('{"a":[1,2]}');
    let result: QueryResult = { ok: true, results: [1, 2] };
    const query: QueryFn = () => Promise.resolve(result);

    render(<QueryPanel query={query} />, container);

    // First, a successful run to populate the results.
    setExpression('$.a[*]');
    runButton().click();
    await tick();
    expect(results()?.value).toBe(JSON.stringify([1, 2], null, 2));

    // Next, an invalid expression returns a typed error with a position.
    result = {
      ok: false,
      error: { message: 'Unexpected token at position 3.', position: 3 },
    };
    setExpression('$.[[');
    runButton().click();
    await tick();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Query failed');
    expect(alert?.textContent).toContain('Unexpected token');
    expect(alert?.textContent).toContain('Character position 3');
    expect(alert?.textContent).toContain('Previous results are unchanged');
  });

  it('surfaces the empty-expression error from the engine', async () => {
    setDocumentText('{"a":1}');
    const query: QueryFn = (payload) =>
      Promise.resolve<QueryResult>(
        payload.expression.trim() === ''
          ? { ok: false, error: { message: 'An expression is required.' } }
          : { ok: true, results: [] },
      );

    render(<QueryPanel query={query} />, container);

    runButton().click();
    await tick();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'An expression is required.',
    );
  });
});
