'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `onChange` whenever the family calendar changes elsewhere. Uses Server-Sent Events; if the stream is
 * down it falls back to refetching on focus, on regaining connectivity, and once a minute.
 */
export function useRealtime(onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    let es: EventSource | null = null;
    let connected = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => cb.current(), 250);
    };

    if (typeof EventSource !== 'undefined') {
      es = new EventSource('/api/stream');
      es.addEventListener('ready', () => {
        connected = true;
        fire(); // catch up on anything missed while disconnected
      });
      es.addEventListener('change', fire);
      es.onerror = () => {
        connected = false;
      };
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') fire();
    };
    const poll = setInterval(() => {
      if (!connected) cb.current();
    }, 60000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', fire);
    window.addEventListener('focus', fire);
    return () => {
      clearTimeout(debounce);
      clearInterval(poll);
      es?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', fire);
      window.removeEventListener('focus', fire);
    };
  }, []);
}
