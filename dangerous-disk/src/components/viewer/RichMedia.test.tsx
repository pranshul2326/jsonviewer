/** @jsxImportSource preact */
// Feature: json-viewer-free — RichMedia rendering unit tests (Task 13.8)
//
// Validates: Requirements 12.2, 12.6
//
// RichMedia is a presentational Preact island. It classifies a scalar value
// with the pure core and renders the matching enrichment. These tests cover
// the two behaviours called out by the task:
//
//   Req 12.2: when an image thumbnail fails to load (it emits a load error),
//             the preview is removed and the value falls back to an activatable
//             link carrying a "could not load" indication.
//   Req 12.6: when rich-media inference is disabled, every value renders as
//             plain text only — no thumbnails, no color swatches, no date
//             annotations, and no activatable links — regardless of whether the
//             value would otherwise classify as an image, color, timestamp, or
//             link.
//
// The thumbnail only mounts after the pointer dwells over the value for the
// 300 ms hover delay, so the failure test hovers, waits past that delay, and
// then dispatches the image's `error` event. We use real timers (the delay is
// short) and let Preact's batched, microtask-deferred re-render settle between
// interactions. This follows the jsdom + `preact` `render` pattern used by
// StatusBar.test.tsx.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { RichMedia } from './RichMedia';

let container: HTMLDivElement;

const IMAGE_URL = 'https://cdn.example.com/photos/cat.png';
// Comfortably past RichMedia's 300 ms HOVER_DELAY_MS so the thumbnail has
// mounted, with margin for timer/scheduling jitter under jsdom.
const PAST_HOVER_MS = 450;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

/** Resolve after `ms` of real time. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Let Preact settle a batched re-render AND flush its effect queue. Effects are
 * deferred to the next animation frame (~16 ms under jsdom), so a full frame's
 * worth of real time is awaited rather than a bare microtask — the image
 * value's mount effect must run before hover state is applied, otherwise it
 * would reset the freshly-shown preview.
 */
const settle = (): Promise<void> => wait(30);

/**
 * Dispatch non-bubbling DOM events by name on the given element.
 *
 * Preact infers a listener's event name from whether the lowercased `on*`
 * property exists on the target node. jsdom elements lack `onpointerenter`, so
 * Preact registers the `onPointerEnter` handler under the capitalized name
 * `PointerEnter` rather than `pointerenter`. We therefore dispatch every name
 * variant the caller supplies so the handler fires regardless of jsdom's
 * property surface; events with no matching listener are harmless no-ops.
 * Standard media events (`load`, `error`) do exist on jsdom `<img>` and
 * register lowercased.
 */
function fire(el: Element, ...types: string[]): void {
  for (const type of types) {
    el.dispatchEvent(new Event(type, { bubbles: false }));
  }
}

/**
 * Mount an enabled RichMedia for an image URL and dwell past the hover delay so
 * the thumbnail `<img>` is in the DOM. Returns the `<img>` so the test can
 * simulate its load outcome.
 */
async function mountImageAndShowPreview(): Promise<HTMLImageElement> {
  render(<RichMedia value={IMAGE_URL} enabled={true} />, container);
  // Let the mount effects run before interacting, so they cannot reset the
  // hover state we are about to apply.
  await settle();

  // No preview before hovering.
  expect(container.querySelector('img')).toBeNull();

  const wrapper = container.querySelector('span');
  expect(wrapper).not.toBeNull();
  // Both the lowercased and Preact-derived (`PointerEnter`) casings, so the
  // hover handler fires whether or not jsdom exposes `onpointerenter`.
  fire(wrapper!, 'pointerenter', 'PointerEnter');

  // Dwell past the hover delay: the thumbnail mounts and begins loading.
  await wait(PAST_HOVER_MS);

  const img = container.querySelector('img');
  expect(img).not.toBeNull();
  return img as HTMLImageElement;
}

describe('RichMedia image load-failure fallback (Req 12.2)', () => {
  it('falls back to an activatable link with a "could not load" note when the image errors', async () => {
    const img = await mountImageAndShowPreview();

    // Simulate the browser failing to load the thumbnail.
    fire(img, 'error');
    await settle();

    // The preview is gone; the value is now an activatable link.
    expect(container.querySelector('img')).toBeNull();

    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(IMAGE_URL);
    // Activatable: opens the target in a new browser tab.
    expect(link?.getAttribute('target')).toBe('_blank');

    // A "could not load" indication accompanies the fallback link.
    const note = container.querySelector('[role="status"]');
    expect(note).not.toBeNull();
    expect(note?.textContent?.toLowerCase()).toContain('could not load');
  });

  it('keeps the preview and shows no fallback indication once the image loads successfully', async () => {
    const img = await mountImageAndShowPreview();

    // A successful load must NOT trigger the failure fallback.
    fire(img, 'load');
    await settle();

    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });
});

describe('RichMedia disabled mode renders plain text only (Req 12.6)', () => {
  // Each value would, when enabled, classify as a distinct rich-media kind.
  // Disabled, every one must render as plain text with no enrichment markup.
  const cases: ReadonlyArray<{ label: string; value: string | number }> = [
    { label: 'image URL', value: IMAGE_URL },
    { label: 'non-image URL', value: 'https://example.com/docs/page' },
    { label: 'hex color', value: '#ff8800' },
    { label: 'Unix timestamp number', value: 1700000000 },
    { label: 'plain string', value: 'just some text' },
  ];

  for (const { label, value } of cases) {
    it(`renders ${label} as plain text with no enrichment`, () => {
      render(<RichMedia value={value} enabled={false} />, container);

      // No activatable links, no thumbnails, no color swatches, no notes.
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('[aria-label*="color swatch"]')).toBeNull();
      expect(container.querySelector('[role="status"]')).toBeNull();

      // No inline backgroundColor swatch styling leaks through.
      const styled = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter(
        (el) => el.style.backgroundColor !== '',
      );
      expect(styled).toHaveLength(0);

      // The full rendered text is exactly the value, with no ISO date or other
      // annotation appended.
      expect(container.textContent).toBe(String(value));
    });
  }

  it('does not annotate a timestamp number with an ISO date when disabled', () => {
    const seconds = 1700000000;
    render(<RichMedia value={seconds} enabled={false} />, container);

    const iso = new Date(seconds * 1000).toISOString();
    expect(container.textContent).not.toContain(iso);
    expect(container.textContent).toBe(String(seconds));
  });
});
