import { useEffect, useState } from 'react';

/**
 * Tracks whether a CSS media query currently matches.
 *
 * Some browsers don't reliably deliver the MediaQueryList 'change' event, so we
 * also re-read on resize/orientationchange. Setting the same boolean is a no-op
 * in React, which keeps those extra events cheap.
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const sync = () => setMatches(mediaQuery.matches);

    sync();
    mediaQuery.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);

    return () => {
      mediaQuery.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, [query]);

  return matches;
}
