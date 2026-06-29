// Milo — the friendly pencil guide. A clean SVG stand-in for the design
// system's `MiloAvatar` component (pencil-character, warm-brown register).
interface Props {
  size?: number;
}

export default function MiloAvatar({ size = 36 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      style={{ overflow: 'visible', display: 'block' }}
      aria-label="Milo"
    >
      {/* pencil body */}
      <g>
        <rect x="22" y="14" width="20" height="34" rx="9" fill="var(--paper)" stroke="var(--accent)" strokeWidth="2" />
        {/* nib / tip */}
        <path d="M22 18 Q32 4 42 18" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        <path d="M29 11 L32 5 L35 11 Z" fill="var(--milo-brown)" />
        <circle cx="32" cy="6" r="1.6" fill="var(--accent)" />
        {/* eyes */}
        <circle cx="28" cy="30" r="2.4" fill="var(--milo-brown)" />
        <circle cx="36" cy="30" r="2.4" fill="var(--milo-brown)" />
        {/* smile */}
        <path d="M27 37 Q32 41 37 37" fill="none" stroke="var(--milo-brown)" strokeWidth="2" strokeLinecap="round" />
        {/* pencil arms */}
        <path d="M22 34 Q12 36 11 44" fill="none" stroke="var(--milo-brown)" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M42 34 Q52 32 55 24" fill="none" stroke="var(--milo-brown)" strokeWidth="2.2" strokeLinecap="round" />
        {/* base band */}
        <rect x="22" y="43" width="20" height="5" rx="2.4" fill="var(--accent-wash-2)" />
      </g>
    </svg>
  );
}
