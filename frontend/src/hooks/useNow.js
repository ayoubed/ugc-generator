import { useEffect, useState } from 'react';

/**
 * Current time in ms. Ticks every second while `active`, so elapsed timers and
 * "stopped responding" checks stay current. Stays still (no re-renders) otherwise.
 */
export function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);
  return now;
}
