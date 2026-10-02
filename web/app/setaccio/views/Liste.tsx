import { api } from '../../../lib/api';
import { PageSection, PageHeader } from '../ui/Page';
import { Pill } from '../ui/Pill';
import { Card } from '../../ds/components/Card';
import { Icon } from '../../ds/components/Icon';

const LISTE = [
  { nome: 'SaaS B2B MI · 5–30M', territorio: 'Milano', count: '410', data: '2 giorni fa', tags: ['Tier A', 'decisore', 'fatturato'] },
  { nome: 'Deeptech TN · alta priorità', territorio: 'Trento', count: '96', data: '6 giorni fa', tags: ['Tier A+B', 'sito'] },
  { nome: 'Biotech PD · da arricchire', territorio: 'Padova', count: '214', data: '12 giorni fa', tags: ['grezze', 'no fatt.'] },
  { nome: 'Cybersecurity TO · pilota', territorio: 'Torino', count: '58', data: '20 giorni fa', tags: ['test'] },
];

export default function Liste() {
  return (
    <PageSection>
      <PageHeader kicker="Output" number="05" title="Liste finali" />
      <div className="sx-grid sx-grid--2 sx-grid--joined">
        {LISTE.map((l) => (
          <Card key={l.nome} as="article" className="sx-list-card">
            <div className="sx-list-card__top">
              <div>
                <h2 className="sx-list-card__title">{l.nome}</h2>
                <span className="sx-meta">{l.territorio}</span>
              </div>
              <span className="sx-stat__value" aria-label={`${l.count} aziende`}>{l.count}</span>
            </div>
            <div className="sx-chips" style={{ gap: '0.4rem' }}>
              {l.tags.map((t) => <Pill key={t} tone="wash">{t}</Pill>)}
            </div>
            <div className="sx-list-card__foot sx-meta">
              <span>creata {l.data}</span>
              <a href={api.companiesCsvUrl()} download className="mm-link sx-iconlink"><Icon name="export" size={13} />Esporta CSV</a>
            </div>
          </Card>
        ))}
      </div>
    </PageSection>
  );
}
