import type { ReactNode } from 'react';
import { Kicker } from '../../ds/components/Kicker';

/** The standard view wrapper: centred column with the entrance motion. */
export function PageSection({ children }: { children: ReactNode }) {
  return <section className="sx-section sx-enter">{children}</section>;
}

interface PageHeaderProps {
  kicker: string;
  /** Section number shared with the sidebar group ("01"). */
  number?: string;
  title: string;
  lead?: ReactNode;
  /** Status line under the lead (banners, sample-data notes). */
  children?: ReactNode;
}

/** Kicker + h1 + optional lead: the top of every view. */
export function PageHeader({ kicker, number, title, lead, children }: PageHeaderProps) {
  return (
    <header className="sx-pagehead">
      <Kicker number={number}>{kicker}</Kicker>
      <h1>{title}</h1>
      {lead && <p className="sx-pagehead__lead">{lead}</p>}
      {children}
    </header>
  );
}

interface PanelHeadProps {
  kicker: string;
  muted?: boolean;
  /** Right-aligned note: a delta, an alert, a unit. */
  aside?: ReactNode;
}

/** Kicker row at the top of a card, with an optional right-hand note. */
export function PanelHead({ kicker, muted, aside }: PanelHeadProps) {
  return (
    <div className="sx-panelhead">
      <Kicker muted={muted}>{kicker}</Kicker>
      {aside}
    </div>
  );
}
