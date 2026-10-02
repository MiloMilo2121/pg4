import type { ReactNode } from 'react';
import { Kicker } from '../../ds/components/Kicker';
import { Icon, type IconName } from '../../ds/components/Icon';

interface CalloutProps {
  kicker?: string;
  /** insight: graphite wash, larger text · quiet: raised paper · error: status red. */
  tone?: 'insight' | 'quiet' | 'error';
  role?: 'status' | 'alert';
  children: ReactNode;
}

export function Callout({ kicker, tone = 'insight', role, children }: CalloutProps) {
  return (
    <div className={`sx-callout${tone === 'insight' ? '' : ` sx-callout--${tone}`}`} role={role}>
      {kicker && <Kicker>{kicker}</Kicker>}
      <div className="sx-callout__text">{children}</div>
    </div>
  );
}

export function EmptyState({ title, icon, children }: { title: string; icon?: IconName; children?: ReactNode }) {
  return (
    <div className="sx-empty">
      {icon && <span className="sx-empty__icon"><Icon name={icon} size={20} /></span>}
      <div className="sx-empty__title">{title}</div>
      {children && <div className="sx-empty__text">{children}</div>}
    </div>
  );
}
