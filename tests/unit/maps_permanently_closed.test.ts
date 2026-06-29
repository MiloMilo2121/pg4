import { describe, expect, it } from 'vitest';
import { parseGoogleMapsResults } from '../../src/discovery/sources/google_maps_parser';

/**
 * Phase C.4 — "Chiuso definitivamente" status span → permanently_closed.
 */

function feedWith(cardsHtml: string): string {
  return `<html><body><div role="feed">${cardsHtml}</div></body></html>`;
}

function card(name: string, spans: string[]): string {
  return `<div class="Nv2PK">
    <a aria-label="${name}" href="/maps/place/${encodeURIComponent(name)}"></a>
    <div class="qBF1Pd">${name}</div>
    <div class="W4Efsd">${spans.map((s) => `<span>${s}</span>`).join('')}</div>
  </div>`;
}

describe('Maps parser permanently_closed — Phase C.4', () => {
  it('captures "Chiuso definitivamente" as permanently_closed=true', () => {
    const html = feedWith(card('Agenzia Defunta', ['Chiuso definitivamente', 'Agenzia immobiliare', 'Via Roma 1, 35100 Padova PD']));
    const r = parseGoogleMapsResults(html, { category: 'agenzie immobiliari', cityHint: 'Padova' });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].permanently_closed).toBe(true);
    // The status span must NOT pollute the category tag either.
    expect(r.results[0].company_name).toBe('Agenzia Defunta');
  });

  it('captures the English "Permanently closed" variant', () => {
    const html = feedWith(card('Closed Co', ['Permanently closed', 'Agenzia immobiliare']));
    const r = parseGoogleMapsResults(html, { category: 'agenzie immobiliari' });
    expect(r.results[0].permanently_closed).toBe(true);
  });

  it('daily-hours statuses (Chiuso / Chiude alle) do NOT mark closed', () => {
    const html = feedWith(card('Agenzia Viva', ['Chiuso ⋅ Apre alle 09', 'Agenzia immobiliare', 'Via Roma 2, 35100 Padova PD']));
    const r = parseGoogleMapsResults(html, { category: 'agenzie immobiliari', cityHint: 'Padova' });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].permanently_closed).toBeUndefined();
  });
});
