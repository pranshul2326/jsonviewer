/** @jsxImportSource preact */
// Feature: json-viewer-free — diff "no differences" UI unit tests (Task 14.5)
//
// Validates: Requirements 9.6
//
// Req 9.6 (Diff Visualization): when the two documents are identical, the
// Application displays no addition/deletion/modification indicators and shows a
// message indicating that no differences were found.
//
// The "no differences" decision lives in the pure `computeDiffViewState`
// (`diff-view-state.ts`), kept out of `DiffPanel` because Monaco does not run
// under jsdom. We test that decision directly, and additionally assert the
// `SemanticDiffList` island (which has no Monaco dependency) renders the
// "no differences found" message for identical documents and suppresses it when
// differences exist.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { computeDiffViewState } from './diff-view-state';
import { SemanticDiffList } from './SemanticDiffList';

describe('computeDiffViewState no-differences state (Req 9.6)', () => {
  it('reports no differences for byte-identical documents', () => {
    const state = computeDiffViewState('{"a":1,"b":2}', '{"a":1,"b":2}');
    expect(state.bothValid).toBe(true);
    expect(state.errors).toHaveLength(0);
    expect(state.noDifferences).toBe(true);
  });

  it('reports no differences when documents differ only in key ordering (Req 8.2 surface)', () => {
    const state = computeDiffViewState('{"a":1,"b":2}', '{"b":2,"a":1}');
    expect(state.bothValid).toBe(true);
    expect(state.noDifferences).toBe(true);
  });

  it('reports no differences when documents differ only in insignificant whitespace', () => {
    const state = computeDiffViewState('{"a":1}', '{\n  "a": 1\n}');
    expect(state.bothValid).toBe(true);
    expect(state.noDifferences).toBe(true);
  });

  it('treats two empty/whitespace-only documents as identical', () => {
    const state = computeDiffViewState('', '   \n\t');
    expect(state.bothValid).toBe(true);
    expect(state.noDifferences).toBe(true);
  });

  it('reports a difference when a scalar value changes', () => {
    const state = computeDiffViewState('{"a":1}', '{"a":2}');
    expect(state.bothValid).toBe(true);
    expect(state.noDifferences).toBe(false);
  });

  it('reports a difference when one side is empty and the other is not', () => {
    const state = computeDiffViewState('', '{"a":1}');
    expect(state.bothValid).toBe(true);
    expect(state.noDifferences).toBe(false);
  });
});

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

const noDifferences = () =>
  container.querySelector('[data-region="no-differences"]');
const differenceList = () =>
  container.querySelector('[data-region="difference-list"]');

describe('SemanticDiffList no-differences message (Req 9.6)', () => {
  it('shows the "no differences found" message for identical documents and no diff rows', () => {
    render(
      <SemanticDiffList leftText='{"a":1,"b":2}' rightText='{"b":2,"a":1}' />,
      container,
    );

    const message = noDifferences();
    expect(message).not.toBeNull();
    expect(message?.textContent?.toLowerCase()).toContain('no');
    expect(message?.textContent?.toLowerCase()).toContain('differences');
    // No addition/deletion/modification indicators are rendered.
    expect(differenceList()).toBeNull();
    expect(container.querySelector('[data-kind]')).toBeNull();
  });

  it('suppresses the no-differences message when the documents differ', () => {
    render(
      <SemanticDiffList leftText='{"a":1}' rightText='{"a":2}' />,
      container,
    );

    expect(noDifferences()).toBeNull();
    expect(differenceList()).not.toBeNull();
    // A difference row carries a classification indicator (Req 9.3–9.5 surface).
    expect(container.querySelector('[data-kind]')).not.toBeNull();
  });
});
