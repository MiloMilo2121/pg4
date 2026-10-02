import type { ReactNode } from 'react';

/** A key cap for shortcut hints ("⌘", "K", "/"). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mm-kbd">{children}</kbd>;
}
