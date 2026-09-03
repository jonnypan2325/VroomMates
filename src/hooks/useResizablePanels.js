import { useCallback, useEffect, useRef, useState } from 'react';

// Wide layout: the divider sets the sidebar's width.
const MIN_SIDEBAR_PERCENT = 22;
const MAX_SIDEBAR_PERCENT = 60;
const DEFAULT_SIDEBAR_PERCENT = 32;

// Stacked layout: the divider sets the map's height instead.
const MIN_MAP_PERCENT = 25;
const MAX_MAP_PERCENT = 78;
const DEFAULT_MAP_PERCENT = 45;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Drives the draggable divider between the form panel and the map.
 *
 * Pointer events give mouse, touch, and stylus a single code path. When
 * `isStacked` is true the panels sit map-over-panel and the divider moves
 * vertically; otherwise they sit side by side and it moves horizontally.
 *
 * Both sizes are returned as percentages and published as CSS custom
 * properties, so each layout's stylesheet rules pick the one that applies.
 */
export default function useResizablePanels(isStacked) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_PERCENT);
  const [mapHeight, setMapHeight] = useState(DEFAULT_MAP_PERCENT);

  const containerRef = useRef(null);
  const isDragging = useRef(false);

  const startResizing = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = isStacked ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  }, [isStacked]);

  const resize = useCallback(
    (event) => {
      if (!isDragging.current || !containerRef.current) return;

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
    if (!isDragging.current) return;
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

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

  const panelStyle = {
    '--sidebar-width': `${sidebarWidth}%`,
    '--map-height': `${mapHeight}%`,
  };

  return { containerRef, panelStyle, startResizing };
}
