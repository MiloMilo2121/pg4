'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cx } from '../../ds/components/cx';
import { Icon } from '../../ds/components/Icon';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour shared by dialogs and the drawer: focus moves in on open,
 * Tab cycles inside, Escape closes, focus returns to the opener on close, and
 * the page behind stops scrolling.
 */
function useModal(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el;
    first.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === head || document.activeElement === el)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [panel]);
}

interface DialogProps {
  onClose: () => void;
  /** Accessible name; pass the id of the visible title via `labelledBy` when there is one. */
  label?: string;
  labelledBy?: string;
  /** Max width in px. */
  width?: number;
  /** Row layout (Milo tour: rail + content). */
  split?: boolean;
  /** Clicking the scrim closes. Off for flows that must be finished or cancelled explicitly. */
  dismissOnScrim?: boolean;
  className?: string;
  children: ReactNode;
}

/** Centred modal dialog on the ink scrim. */
export function Dialog({ onClose, label, labelledBy, width = 720, split, dismissOnScrim = true, className, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  return (
    <div className="sx-scrim" onMouseDown={(e) => { if (dismissOnScrim && e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx('sx-dialog sx-enter', split && 'sx-dialog--split', className)}
        style={{ '--dialog-w': `${width}px` } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}

/** Right-side drawer on the ink scrim. */
export function Drawer({ onClose, labelledBy, children }: { onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  return (
    <div className="sx-drawer-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} className="sx-drawer sx-enter">
        {children}
      </aside>
    </div>
  );
}

/** ✕ close control with an accessible name. */
export function CloseButton({ onClick, label = 'Chiudi' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="sx-iconbtn" onClick={onClick} aria-label={label} title={label}>
      <Icon name="close" size={14} />
    </button>
  );
}
