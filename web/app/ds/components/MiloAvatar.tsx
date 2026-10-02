'use client';

import { useEffect, useRef } from 'react';
import { cx } from './cx';

interface MiloAvatarProps {
  size?: number;
  /** Pupils follow the cursor. Off on touch screens and under reduced motion. */
  interactive?: boolean;
  /** Decorative when a visible "Milo" label sits next to it. */
  decorative?: boolean;
  className?: string;
}

/**
 * Milo, the pencil-doodle assistant (DS v2 port of components/brand/MiloAvatar).
 * The only living thing in the system: nothing else moves on its own.
 */
export function MiloAvatar({ size = 64, interactive = false, decorative = false, className }: MiloAvatarProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!interactive || !el) return;
    const still = window.matchMedia('(pointer: coarse), (prefers-reduced-motion: reduce)');
    if (still.matches) return;
    const pupils = el.querySelectorAll<SVGRectElement>('.m-pupil');
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const p = Math.min(d / 80, 1) * 2.4;
      pupils.forEach((pp) => {
        pp.style.transform = `translate(${(dx / d) * p}px, ${(dy / d) * p}px)`;
      });
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, [interactive]);

  return (
    <span ref={ref} className={cx('mm-milo', className)} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'Milo' })}
      >
        <path d="M9.5 58 C 11.2 48.8, 17 44.4, 26.8 42.3 L 31 50.8 L 29.3 58 Z" fill="var(--milo-coat)" />
        <path d="M54.5 58 C 52.8 48.8, 47 44.4, 37.2 42.3 L 33 50.8 L 34.7 58 Z" fill="var(--milo-coat)" />
        <path d="M27.3 41.9 L 36.7 41.9 L 32 51.2 Z" strokeWidth="1.2" strokeLinejoin="round" fill="var(--paper-hi)" stroke="var(--milo-coat)" />
        <path d="M27.9 41.9 L 32 45.2 L 36.1 41.9" fill="none" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" stroke="var(--milo-coat)" />
        <path
          d="M26.8 42.3 C 28.6 45.8, 30 48.6, 31 50.8 M37.2 42.3 C 35.4 45.8, 34 48.6, 33 50.8"
          fill="none"
          strokeWidth="1"
          strokeLinecap="round"
          stroke="rgba(var(--paper-hi-rgb),0.5)"
        />
        <path d="M23.8 49.8 L 26.8 49.3 L 25.9 52.1 Z" fill="var(--accent-2)" />
        <path d="M27.6 36.6 L 27.3 41.8 M36.4 36.6 L 36.7 41.8" strokeWidth="2" strokeLinecap="round" stroke="var(--accent)" />
        <path
          d="M32 11 C 39.8 11, 44.8 17, 44.4 24.8 C 44 32.3, 38.6 36.9, 31.9 36.7 C 25.2 36.5, 20.3 31.6, 20.2 24.6 C 20.1 17.2, 24.6 11.2, 32 11 Z"
          strokeWidth="2"
          strokeLinecap="round"
          fill="var(--paper-hi)"
          stroke="var(--accent)"
        />
        <path
          d="M20.5 23.5 C 19.3 13.8, 25.8 8.4, 32.4 8.6 C 39.3 8.8, 44.8 13.8, 44.5 21.8 C 43.6 19.6, 42.2 17.8, 40.2 16.8 C 40.8 18.4, 40.6 19.6, 39.8 20.6 C 37.4 16.6, 33 15.2, 29 16 C 29.6 17, 29.5 18, 28.8 18.8 C 26 17.6, 23.2 18.6, 21.8 20.9 C 21.2 21.7, 20.8 22.5, 20.5 23.5 Z"
          fill="var(--accent)"
        />
        <rect className="m-pupil" x="25.9" y="21" width="3.4" height="8" rx="1.7" fill="var(--ink)" />
        <rect className="m-pupil" x="34.7" y="21" width="3.4" height="8" rx="1.7" fill="var(--ink)" />
      </svg>
    </span>
  );
}
