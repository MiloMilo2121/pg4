import type { ReactNode } from 'react';

interface TableProps {
  /** Relative column weights (like grid fr units), turned into percentages. */
  cols: number[];
  head: string[];
  /** Below this width the table scrolls horizontally instead of squashing. */
  minWidth?: number;
  label: string;
  children: ReactNode;
}

/**
 * A real <table> in the DS register. Clickable rows keep a <button> in their
 * first cell (keyboard + screen reader path); the row click is a mouse shortcut.
 */
export function Table({ cols, head, minWidth, label, children }: TableProps) {
  const total = cols.reduce((s, n) => s + n, 0) || 1;
  return (
    <div className="sx-table-wrap">
      <table className="sx-table" aria-label={label} style={minWidth ? { minWidth } : undefined}>
        <colgroup>
          {cols.map((c, i) => (
            <col key={i} style={{ width: `${((100 * c) / total).toFixed(2)}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
