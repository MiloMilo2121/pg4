import type { ReactNode } from 'react';
import { cx } from './cx';

/*
 * Utility icons for the "Grafite / app" variant.
 *
 * The DS has no icon library on purpose ("bespoke pencil SVGs, 1.6px stroke";
 * readme → Iconography). This set follows that rule and flags the one
 * substitution it makes: the pencil roughness is dropped for a clean,
 * geometric line so the app reads as an instrument. The vocabulary is the
 * DS one: hairline strokes plus nodes, solid when something is done or
 * selected, open when it waits.
 *
 * Grid 16×16, live area 1.5–14.5, stroke 1.5px, square caps, mitre joins.
 * Strokes use currentColor, so an icon takes the colour of its text.
 */

const N = (cx: number, cy: number, open = false, r = 1.6) => (
  <circle cx={cx} cy={cy} r={r} className={open ? 'mm-icon__node-open' : 'mm-icon__node'} />
);

const ICONS = {
  // ---- navigation ----
  cockpit: (
    <>
      <path d="M2 12.5a6 6 0 0 1 12 0" />
      <path d="M8 12.5 11 7" />
      {N(8, 12.5)}
    </>
  ),
  dataset: (
    <>
      <path d="M2.5 2.5h11v11h-11z" />
      <path d="M2.5 6.2h11M2.5 9.8h11" />
    </>
  ),
  companies: (
    <>
      <path d="M3 14V3h6.5v11M9.5 6.5H13V14M1.5 14h13" />
      <path d="M5.25 6h2M5.25 9h2" />
    </>
  ),
  map: (
    <>
      <path d="M1.5 3.5 5.5 2l5 1.5 4-1.5V12.5l-4 1.5-5-1.5-4 1.5z" />
      <path d="M5.5 2v10.5M10.5 3.5V14" />
    </>
  ),
  funnel: (
    <>
      <path d="M1.75 2.75h12.5L9.5 8.5v4.75l-3 1.25v-6z" />
    </>
  ),
  matrix: (
    <>
      {N(3.5, 3.5, true, 1.4)}{N(8, 3.5, true, 1.4)}{N(12.5, 3.5, false, 1.4)}
      {N(3.5, 8, true, 1.4)}{N(8, 8, true, 1.4)}{N(12.5, 8, true, 1.4)}
      {N(3.5, 12.5, true, 1.4)}{N(8, 12.5, true, 1.4)}{N(12.5, 12.5, true, 1.4)}
    </>
  ),
  analytics: (
    <>
      <path d="M2.5 2v11.5H14" />
      <path d="M5.5 11V8M8.5 11V4.5M11.5 11V6.5" />
    </>
  ),
  system: (
    <>
      <path d="M1.5 2.5h13v11h-13z" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5H11" />
    </>
  ),
  lists: (
    <>
      {N(3, 3.75, false, 1.2)}{N(3, 8, false, 1.2)}{N(3, 12.25, false, 1.2)}
      <path d="M6 3.75h8.5M6 8h8.5M6 12.25h8.5" />
    </>
  ),
  // ---- utility ----
  search: (
    <>
      <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z" />
      <path d="m10.25 10.25 4 4" />
    </>
  ),
  close: <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />,
  arrow: <path d="M2 8h11.5M9.5 4l4 4-4 4" />,
  external: <path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v4h-9v-9h4" />,
  filter: <path d="M1.5 4h13M4 8h8M6.5 12h3" />,
  export: <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2 14h12" />,
  sort: <path d="M5 2.5V13M2.5 10.5 5 13l2.5-2.5M11 13.5V3M8.5 5.5 11 3l2.5 2.5" />,
  job: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  alert: (
    <>
      <path d="M8 1.75 14.75 14H1.25z" />
      <path d="M8 6.25v3.5M8 11.5v.75" />
    </>
  ),
  menu: <path d="M2 4h12M2 8h12M2 12h12" />,
  command: (
    <>
      <path d="M2 2h12v12H2z" />
      <path d="m5 6 2 2-2 2M8.5 10.5H11" />
    </>
  ),
  keyboard: (
    <>
      <path d="M1.5 4h13v8h-13z" />
      <path d="M4 7h1M7.5 7h1M11 7h1M5 9.75h6" />
    </>
  ),
  // ---- status nodes (shape, not only colour, carries the state) ----
  'node-ok': N(8, 8, false, 3.25),
  'node-wait': N(8, 8, true, 3.25),
  'node-run': (
    <>
      {N(8, 8, true, 3.25)}
      {N(8, 8, false, 1.4)}
    </>
  ),
  'node-ko': (
    <>
      {N(8, 8, true, 3.25)}
      <path d="m5.75 10.25 4.5-4.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  size?: number;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  title?: string;
  className?: string;
}

export function Icon({ name, size = 16, title, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cx('mm-icon', className)}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true, focusable: false })}
    >
      {ICONS[name]}
    </svg>
  );
}
