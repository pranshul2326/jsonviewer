/** @jsxImportSource preact */
// Feature: json-viewer-free — StatusBar validation-indicator unit tests (Task 12.3)
//
// Validates: Requirements 6.2, 6.3, 6.4
//
// StatusBar is a presentational island that reflects the shared `$document`
// store. These tests drive the store via `setDocumentText` (the same path the
// editor uses) and render StatusBar into a jsdom container, asserting the
// indicator it shows:
//
//   Req 6.2: valid JSON shows a valid-state indicator that is visually distinct
//            from the error-state indicator (distinct `data-status`, color
//            token, and glyph).
//   Req 6.3: empty / whitespace-only content shows the valid indicator and no
//            error indicator.
//   Req 6.4: a syntax error shows the error description together with the
//            1-based line:column of the first error.
//
// Monaco itself is not involved here — StatusBar reads only the parsed result —
// so this renders cleanly under jsdom without the editor or its workers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { $document, setDocumentText } from '../../lib/stores/document';
import { StatusBar } from './StatusBar';

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

/** Set the shared document then mount a fresh StatusBar reflecting it. */
function mountWith(text: string): void {
  setDocumentText(text);
  render(<StatusBar />, container);
}

const valid = () => container.querySelector('[data-status="valid"]');
const error = () => container.querySelector('[data-status="error"]');

describe('StatusBar valid indicator (Req 6.2)', () => {
  it('shows the valid indicator for valid JSON and no error indicator', () => {
    mountWith('{"a":1}');

    expect(valid()).not.toBeNull();
    expect(error()).toBeNull();
    expect(valid()?.textContent).toContain('Valid');
  });

  it('renders a valid indicator visually distinct from the error indicator', () => {
    // Valid: success token, no error token.
    mountWith('[1,2,3]');
    const validEl = valid();
    expect(validEl).not.toBeNull();
    expect(validEl?.getAttribute('class')).toContain('text-success');

    // Error (separate mount): error token, distinct status attribute.
    mountWith('{ "a": }');
    const errorEl = error();
    expect(errorEl).not.toBeNull();
    expect(errorEl?.getAttribute('class')).toContain('text-error');
    // The two states never share the same data-status value.
    expect(errorEl?.getAttribute('data-status')).not.toBe('valid');
  });
});

describe('StatusBar empty/whitespace shows valid, no error (Req 6.3)', () => {
  it('shows the valid indicator for empty content', () => {
    mountWith('');

    expect(valid()).not.toBeNull();
    expect(error()).toBeNull();
  });

  it('shows the valid indicator for whitespace-only content', () => {
    mountWith('   \n\t  ');

    expect(valid()).not.toBeNull();
    expect(error()).toBeNull();
  });
});

describe('StatusBar error indicator with 1-based line:column (Req 6.4)', () => {
  it('shows the error description and the first-error 1-based line:column', () => {
    const text = '{ "a": }';
    setDocumentText(text);
    const parsed = $document.get().parsed;
    if (parsed.ok) throw new Error('expected a parse error');
    const { line, column, message } = parsed.error;

    render(<StatusBar />, container);

    const errorEl = error();
    expect(errorEl).not.toBeNull();
    expect(valid()).toBeNull();
    // The description and the 1-based line:column are both rendered.
    expect(errorEl?.textContent).toContain(message);
    expect(errorEl?.textContent).toContain(`${line}:${column}`);
  });

  it('reports the line:column on the correct line for a multi-line error', () => {
    const text = '{\n  "a" 1\n}';
    setDocumentText(text);
    const parsed = $document.get().parsed;
    if (parsed.ok) throw new Error('expected a parse error');
    const { line, column } = parsed.error;

    render(<StatusBar />, container);

    expect(line).toBe(2);
    expect(error()?.textContent).toContain(`${line}:${column}`);
  });
});

describe('StatusBar invalid -> valid transition (Req 6.6 surface)', () => {
  it('replaces the error indicator with the valid indicator once corrected', () => {
    mountWith('{ "a": }');
    expect(error()).not.toBeNull();
    expect(valid()).toBeNull();

    // Correct the document and re-mount; the error indicator is gone.
    render(null, container);
    mountWith('{ "a": 1 }');

    expect(valid()).not.toBeNull();
    expect(error()).toBeNull();
  });
});
