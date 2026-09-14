"use client";

import { useEffect, useState } from "react";

/** Unix seconds, ticking every `intervalMs`. Starts at 0 during prerender to avoid hydration drift. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** True after first client render; use to gate wallet-dependent UI from prerendered HTML. */
export function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}
