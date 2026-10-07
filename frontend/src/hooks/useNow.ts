import { useEffect, useState } from 'react';

/** Relógio que reatualiza a cada `intervalMs` — mantém textos como "há 5 min" corretos. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
