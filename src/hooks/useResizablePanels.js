import { useCallback, useEffect, useRef, useState } from 'react';

// Wide layout: the divider sets the sidebar's width.
const MIN_SIDEBAR_PERCENT = 22;
const MAX_SIDEBAR_PERCENT = 60;
const DEFAULT_SIDEBAR_PERCENT = 32;

// Stacked layout: the divider sets the map's height instead.
const MIN_MAP_PERCENT = 25;
const MAX_MAP_PERCENT = 78;
const DEFAULT_MAP_PERCENT = 45;

// Heights the map snaps between when the handle is tapped rather than dragged.
const MAP_SNAP_TALL = 72;
const MAP_SNAP_SHORT = 40;
const MAP_SNAP_MIDPOINT = (MAP_SNAP_TALL + MAP_SNAP_SHORT) / 2;

// Pointer travel below this counts as a tap, not a drag.
const TAP_SLOP_PX = 4;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Drives the draggable divider between the form panel and the map.
 *
 * Pointer events give mouse, touch, and stylus a single code path. When
 * `isStacked` is true the panels sit map-over-panel and the divider moves
 * vertically; otherwise they sit side by side and it moves horizontally.
 *
 * Returns percentages rather than pixels so the split survives a viewport
 * change, and so CSS can fall back to a sensible default if these are unset.
 */
export default function useResizablePanels(isStacked) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_PERCENT);
  const [mapHeight, setMapHeight] = useState(DEFAULT_MAP_PERCENT);

  const containerRef = useRef(null);
  const drag = useRef({ active: false, moved: false, startX: 0, startY: 0 });

  const startResizing = useCallback(
    (event) => {
      drag.current = { active: true, moved: false, startX: event.clientX, startY: event.clientY };
      document.body.style.cursor = isStacked ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [isStacked]
  );

  const resize = useCallback(
    (event) => {
      const state = drag.current;
      if (!state.active || !containerRef.current) return;

      if (
        Math.abs(event.clientX - state.startX) > TAP_SLOP_PX ||
        Math.abs(event.clientY - state.startY) > TAP_SLOP_PX
      ) {
        state.moved = true;
      }

      const bounds = containerRef.current.getBoundingClientRect();
      if (isStacked) {
        const percent = ((event.clientY - bounds.top) / bounds.height) * 100;
        setMapHeight(clamp(percent, MIN_MAP_PERCENT, MAX_MAP_PERCENT));
      } else {
        const percent = ((event.clientX - bounds.left) / bounds.width) * 100;
        setSidebarWidth(clamp(percent, MIN_SIDEBAR_PERCENT, MAX_SIDEBAR_PERCENT));
      }
    },
    [isStacked]
  );

  const stopResizing = useCallback(() => {
    const state = drag.current;
    if (!state.active) return;

    // Tapping the stacked handle toggles the map between tall and short.
    if (isStacked && !state.moved) {
      setMapHeight((height) => (height > MAP_SNAP_MIDPOINT ? MAP_SNAP_SHORT : MAP_SNAP_TALL));
    }

    state.active = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [isStacked]);

  // Listen on the document so a fast drag that outruns the handle still tracks.
  useEffect(() => {
    document.addEventListener('pointermove', resize);
    document.addEventListener('pointerup', stopResizing);
    document.addEventListener('pointercancel', stopResizing);

    return () => {
      document.removeEventListener('pointermove', resize);
      document.removeEventListener('pointerup', stopResizing);
      document.removeEventListener('pointercancel', stopResizing);
    };
  }, [resize, stopResizing]);

  return { containerRef, sidebarWidth, mapHeight, startResizing };
}
