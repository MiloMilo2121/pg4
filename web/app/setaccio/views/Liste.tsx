import { api } from '../../../lib/api';

const SECTION = { padding: '34px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;

const LISTE = [
  { nome: 'Metalmecc. VI · 5–30M', territorio: 'Vicenza', count: '620', data: '2 giorni fa', tags: ['Tier A', 'decisore', 'fatturato'] },
  { nome: 'Serramenti VR · alta priorità', territorio: 'Verona', count: '410', data: '6 giorni fa', tags: ['Tier A+B', 'sito'] },
  { nome: 'Edili PD · da arricchire', territorio: 'Padova', count: '980', data: '12 giorni fa', tags: ['grezze', 'no fatt.'] },
  { nome: 'Hospitality VE · pilota', territorio: 'Venezia', count: '240', data: '20 giorni fa', tags: ['test'] },
];

export default function Liste() {
  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Output</span></div>
      <h1 style={{ fontSize: '1.95rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 22 }}>Liste finali</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
        {LISTE.map((l) => (
          <div key={l.nome} className="ag-card-h" style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 15, padding: '22px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: '1.2rem', fontWeight: 500 }}>{l.nome}</div>
                <div style={{ fontSize: '.8rem', color: 'var(--ink-3)', marginTop: 3 }}>{l.territorio}</div>
              </div>
              <span style={{ fontFamily: 'var(--serif)', fontSize: '1.7rem', fontWeight: 500, color: 'var(--accent)' }}>{l.count}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {l.tags.map((t) => (
                <span key={t} style={{ fontSize: '.72rem', padding: '4px 10px', borderRadius: 999, background: 'var(--accent-wash)', color: 'var(--accent)', fontWeight: 600 }}>{t}</span>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.76rem', color: 'var(--ink-3)' }}>
              <span>creata {l.data}</span>
              <a href={api.companiesCsvUrl()} download className="link-u" style={{ textDecoration: 'none' }}>Esporta CSV →</a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
