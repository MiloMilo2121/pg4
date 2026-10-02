'use client';

import { useEffect, useRef } from 'react';
import type { Nav } from './data';
import { NAV_ITEMS } from './nav';

interface Handlers {
  /** True while any overlay is open: single-key shortcuts pause, ⌘K still works. */
  overlayOpen: boolean;
  go: (nav: Nav) => void;
  palette: () => void;
  help: () => void;
  search: () => void;
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * Global keyboard map: ⌘K / Ctrl K palette, "/" search, "?" help, and "g" then
 * a letter (within 1.2 s) to jump to a view. Single keys never fire while the
 * user is typing or an overlay is open.
 */
export function useShortcuts(h: Handlers) {
  const ref = useRef(h);
  useEffect(() => {
    ref.current = h;
  });

  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const { overlayOpen, go, palette, help, search } = ref.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        palette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || overlayOpen || typing(e.target)) return;
      if (e.key === '/') { e.preventDefault(); search(); return; }
      if (e.key === '?') { e.preventDefault(); help(); return; }
      if (e.key === 'g') { gAt = Date.now(); return; }
      if (gAt && Date.now() - gAt < 1200) {
        const item = NAV_ITEMS.find((n) => n.key === e.key);
        gAt = 0;
        if (item) { e.preventDefault(); go(item.id); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
