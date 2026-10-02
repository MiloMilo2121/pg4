import { cx } from './cx';

interface LogoProps {
  /** Width in px; the five-stroke monogram keeps its 240×112 ratio. Never crop it. */
  size?: number;
  className?: string;
}

/** The MM monogram (five peaks, five career roles). Inherits `color`: graphite on paper, light on night. */
export function Logo({ size = 40, className }: LogoProps) {
  return (
    <span className={cx('mm-logo', className)} style={{ width: size }}>
      <svg viewBox="0 0 240 112" role="img" aria-label="Marco Milanello">
        <path
          d="M6 106 L6 6 L56 62 L106 6 L106 106 L134 106 L134 6 L184 62 L234 6 L234 106"
          fill="none"
          stroke="currentColor"
          strokeWidth={14}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
