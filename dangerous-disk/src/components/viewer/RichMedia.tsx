// Feature: json-viewer-free
//
// RichMedia presentation component (Req 12.1, 12.2, 12.5, 12.6).
//
// Given a scalar Node value (string or number) and whether rich-media
// inference is enabled, this Preact island renders the appropriate enrichment
// using the PURE classification core in `../../lib/json-core/richmedia`:
//
//   - image     -> the value text plus an inline indicator; hovering the value
//                  for >= 300 ms reveals an image thumbnail constrained to
//                  <= 200x200 px. If the image errors or does not load within
//                  5 s, the preview is removed and the value falls back to an
//                  activatable link with a "could not load image" note (12.2).
//   - color     -> a 14 px swatch filled with the exact color, adjacent to the
//                  value. The swatch background is the only dynamic color and
//                  comes from the data value itself.
//   - timestamp -> the value with its human-readable ISO 8601 date adjacent.
//   - link      -> an activatable link opening in a new browser tab (12.5).
//   - none      -> the value as plain text.
//
// When `enabled` is false, EVERY value renders as plain text with no
// thumbnails, swatches, date annotations, or links (Req 12.6).
//
// All decision logic lives in the pure core; this component owns only the DOM
// presentation, hover timing, and image load/timeout/error state.

import { useEffect, useRef, useState } from 'preact/hooks';
import { classifyValue } from '../../lib/json-core/richmedia';

/** Delay the pointer must dwell over an image value before the preview shows. */
const HOVER_DELAY_MS = 300;

/** Maximum time an image preview is allowed to load before falling back. */
const IMAGE_LOAD_TIMEOUT_MS = 5000;

/** Props for {@link RichMedia}. */
export interface RichMediaProps {
  /** The scalar Node value to present. */
  value: string | number;
  /** Whether rich-media inference is enabled (Req 12.6 disables all of it). */
  enabled: boolean;
}

/** Shared plain-text rendering used for `none` values and the disabled mode. */
function PlainText({ value }: { value: string | number }) {
  return <span class="font-mono text-body-sm text-ink">{String(value)}</span>;
}

/**
 * Activatable link that opens the target URL in a new browser tab (Req 12.5).
 * Used directly for non-image URLs and as the fallback for failed images.
 */
function LinkValue({ url, note }: { url: string; note?: string }) {
  return (
    <span class="inline-flex items-center gap-xxs">
      <a
        class="font-mono text-body-sm text-link underline hover:text-link-deep"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {url}
      </a>
      {note ? (
        <span class="text-caption text-error" role="status">
          {note}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Color value: the text plus a 14 px swatch filled with the exact color
 * (Req 12.3). The swatch background is data-driven, so it is the single
 * permitted dynamic color; every other style uses theme tokens.
 */
function ColorValue({ value, color }: { value: string; color: string }) {
  return (
    <span class="inline-flex items-center gap-xxs">
      <span class="font-mono text-body-sm text-ink">{value}</span>
      <span
        class="inline-block h-3.5 w-3.5 rounded-xs border border-hairline align-middle"
        style={{ backgroundColor: color }}
        aria-label={`color swatch ${color}`}
      />
    </span>
  );
}

/**
 * Timestamp value: the raw number plus its ISO 8601 rendering adjacent
 * (Req 12.4). The ISO string is computed by the pure core.
 */
function TimestampValue({ value, iso }: { value: number; iso: string }) {
  return (
    <span class="inline-flex items-center gap-xs">
      <span class="font-mono text-body-sm text-ink">{value}</span>
      <span class="text-caption-mono text-mute">{iso}</span>
    </span>
  );
}

type ImageLoadState = 'idle' | 'loading' | 'loaded' | 'failed';

/**
 * Image value (Req 12.1, 12.2).
 *
 * Renders the URL text with an inline preview indicator. Hovering for
 * {@link HOVER_DELAY_MS} reveals the thumbnail, constrained to <= 200x200 px.
 * The thumbnail begins loading when first requested; an `onerror` or a load
 * that exceeds {@link IMAGE_LOAD_TIMEOUT_MS} marks the image as failed,
 * permanently removing the preview and falling back to an activatable link
 * with a "could not load image" indication.
 */
function ImageValue({ url }: { url: string }) {
  const [showPreview, setShowPreview] = useState(false);
  const [loadState, setLoadState] = useState<ImageLoadState>('idle');

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const clearLoadTimer = () => {
    if (loadTimer.current !== null) {
      clearTimeout(loadTimer.current);
      loadTimer.current = null;
    }
  };

  // Tear down any pending timers when the value changes or unmounts.
  useEffect(() => clearHoverTimer, []);
  useEffect(() => clearLoadTimer, []);

  // Reset state whenever the underlying URL changes.
  useEffect(() => {
    clearHoverTimer();
    clearLoadTimer();
    setShowPreview(false);
    setLoadState('idle');
  }, [url]);

  const handlePointerEnter = () => {
    if (loadState === 'failed') return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      setShowPreview(true);
      setLoadState((prev) => {
        if (prev === 'idle') {
          clearLoadTimer();
          loadTimer.current = setTimeout(() => {
            clearLoadTimer();
            setShowPreview(false);
            setLoadState('failed');
          }, IMAGE_LOAD_TIMEOUT_MS);
          return 'loading';
        }
        return prev;
      });
    }, HOVER_DELAY_MS);
  };

  const handlePointerLeave = () => {
    clearHoverTimer();
    setShowPreview(false);
  };

  const handleLoad = () => {
    clearLoadTimer();
    setLoadState('loaded');
  };

  const handleError = () => {
    clearLoadTimer();
    setShowPreview(false);
    setLoadState('failed');
  };

  // Req 12.2: once the image cannot load, drop the preview entirely and render
  // the value as an activatable link with a "could not load" indication.
  if (loadState === 'failed') {
    return <LinkValue url={url} note="could not load image" />;
  }

  return (
    <span
      class="relative inline-flex items-center gap-xxs"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <span class="font-mono text-body-sm text-ink">{url}</span>
      <span class="text-caption text-mute" aria-label="image preview available">
        ⧉
      </span>
      {showPreview ? (
        <span class="absolute left-0 top-full z-10 mt-xxs rounded-sm border border-hairline bg-canvas p-xxs shadow-level-5">
          <img
            class="block max-h-[200px] max-w-[200px] object-contain"
            src={url}
            alt="image preview"
            onLoad={handleLoad}
            onError={handleError}
          />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Render a scalar value with rich-media enrichment.
 *
 * Disabled mode short-circuits to plain text (Req 12.6); otherwise the value is
 * classified by the pure core and dispatched to the matching presenter.
 */
export function RichMedia({ value, enabled }: RichMediaProps) {
  if (!enabled) {
    return <PlainText value={value} />;
  }

  const classification = classifyValue(value);

  switch (classification.kind) {
    case 'image':
      return <ImageValue url={classification.url} />;
    case 'color':
      return <ColorValue value={String(value)} color={classification.color} />;
    case 'timestamp':
      return <TimestampValue value={classification.seconds} iso={classification.iso} />;
    case 'link':
      return <LinkValue url={classification.url} />;
    case 'none':
    default:
      return <PlainText value={value} />;
  }
}

export default RichMedia;
