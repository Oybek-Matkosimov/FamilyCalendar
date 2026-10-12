'use client';

import { useEffect } from 'react';

/** Registers the tiny offline-page service worker so browsers treat the site as an installable app. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        /* the app works fine without it */
      });
    }
  }, []);
  return null;
}
