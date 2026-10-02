import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SuppressionList, suppressionForCommand, dropSuppressedEmails } from '../../src/compliance/suppression';
import type { Lead } from '../../src/types/lead';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-suppr-'));
}

const LIST_CSV = `phone,vat,reason,date
+390422000177,,operator_request,2026-06-01
,01234567897,gdpr_deletion,2026-05-20
348 0000591,,bounce_complaint,2026-04-10
`;

describe('SuppressionList', () => {
  it('matches phones across formats (spaces, +39, 0039, bare)', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'suppression.csv');
    fs.writeFileSync(p, LIST_CSV, 'utf8');
    const list = SuppressionList.fromFile(p);

    expect(list.active).toBe(true);
    expect(list.matches({ company_name: 'X', phone: '0422 000177' })).toBe(true);
    expect(list.matches({ company_name: 'X', phone: '+39 0422 000177' })).toBe(true);
    expect(list.matches({ company_name: 'X', phone: '0039 0422-00-01-77' })).toBe(true);
    expect(list.matches({ company_name: 'X', phone: '+393480000591' })).toBe(true);
    expect(list.matches({ company_name: 'X', phone: '0422 999999' })).toBe(false);
  });

  it('matches the E.164-normalized phone via phone_raw too', () => {
    const dir = tmpDir();
    const p = path.join(dir, 's.csv');
    fs.writeFileSync(p, 'phone,vat,reason,date\n0422000177,,x,2026-01-01\n', 'utf8');
    const list = SuppressionList.fromFile(p);
    expect(list.matches({ company_name: 'X', phone: '+390422000177', phone_raw: '0422 000177' })).toBe(true);
  });

  it('matches vat on both vat_code and vat_code_final', () => {
    const dir = tmpDir();
    const p = path.join(dir, 's.csv');
    fs.writeFileSync(p, LIST_CSV, 'utf8');
    const list = SuppressionList.fromFile(p);
    expect(list.matches({ company_name: 'X', vat_code: '01234567897' })).toBe(true);
    expect(list.matches({ company_name: 'X', vat_code_final: 'IT01234567897' })).toBe(true);
    expect(list.matches({ company_name: 'X', vat_code: '99999999999' })).toBe(false);
  });

  it('resolve(): auto-discovers suppression.csv next to the output', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'suppression.csv'), LIST_CSV, 'utf8');
    const list = SuppressionList.resolve({ outCsv: path.join(dir, 'campaign.csv') });
    expect(list.active).toBe(true);
    expect(list.sourcePath).toBe(path.join(dir, 'suppression.csv'));
  });

  it('resolve(): no list anywhere → disabled, matches nothing', () => {
    const dir = tmpDir();
    const list = SuppressionList.resolve({ outCsv: path.join(dir, 'campaign.csv') });
    expect(list.active).toBe(false);
    expect(list.matches({ company_name: 'X', phone: '0422000177' })).toBe(false);
  });

  it('resolve(): an EXPLICIT path that cannot be read throws (operator asked for protection)', () => {
    const dir = tmpDir();
    expect(() =>
      SuppressionList.resolve({ flagPath: path.join(dir, 'missing.csv'), outCsv: path.join(dir, 'c.csv') })
    ).toThrow();
  });
});

const EMAIL_CSV = `phone,vat,email,reason,date
,,Info@Rossi.it,gdpr_objection,2026-06-01
`;

function listFrom(csv: string): SuppressionList {
  const p = path.join(tmpDir(), 'suppression.csv');
  fs.writeFileSync(p, csv, 'utf8');
  return SuppressionList.fromFile(p);
}

describe('SuppressionList — email entries', () => {
  it('a list with only emails is active', () => {
    expect(listFrom(EMAIL_CSV).active).toBe(true);
  });

  it('dropSuppressedEmails clears every suppressed address on the lead, case-insensitively', () => {
    const list = listFrom(EMAIL_CSV);
    const lead: Lead = { company_name: 'Rossi', email: 'info@rossi.it', email_inferred: 'INFO@rossi.it', email_type: 'business', email_status: 'deliverable', pec: 'rossi@pec.it' };
    const dropped = list.dropSuppressedEmails(lead);
    expect(dropped.sort()).toEqual(['email', 'email_inferred']);
    expect(lead.email).toBeUndefined();
    expect(lead.email_inferred).toBeUndefined();
    expect(lead.email_status).toBeUndefined(); // described the dropped address
    expect(lead.email_type).toBe('pec'); // the PEC is what is left
    expect(lead.pec).toBe('rossi@pec.it');
  });

  it('dropSuppressedEmails also clears a suppressed PEC', () => {
    const lead: Lead = { company_name: 'Rossi', pec: 'info@rossi.it', email_type: 'pec' };
    expect(dropSuppressedEmails(lead, (e) => e.toLowerCase() === 'info@rossi.it')).toEqual(['pec']);
    expect(lead.pec).toBeUndefined();
    expect(lead.email_type).toBeUndefined();
  });

  it('dropSuppressedEmails leaves a clean lead untouched', () => {
    const lead: Lead = { company_name: 'Bianchi', email_inferred: 'info@bianchi.it', email_type: 'business' };
    expect(listFrom(EMAIL_CSV).dropSuppressedEmails(lead)).toEqual([]);
    expect(lead).toEqual({ company_name: 'Bianchi', email_inferred: 'info@bianchi.it', email_type: 'business' });
  });
});

describe('SuppressionList.apply — the filter every command runs before emitting', () => {
  it('drops matching companies and strips suppressed emails from the rest', () => {
    const list = listFrom(`phone,vat,email,reason,date
,01234567897,,gdpr_deletion,2026-05-20
,,info@rossi.it,gdpr_objection,2026-06-01
`);
    const leads: Lead[] = [
      { company_name: 'Suppressed', vat_code_final: '01234567897' },
      { company_name: 'Rossi', email_inferred: 'info@rossi.it' },
      { company_name: 'Clean', email_inferred: 'a@b.it' },
    ];
    const { kept, suppressed } = list.apply(leads);
    expect(suppressed).toBe(1);
    expect(kept.map((l) => l.company_name)).toEqual(['Rossi', 'Clean']);
    expect(kept[0].email_inferred).toBeUndefined();
    expect(kept[1].email_inferred).toBe('a@b.it');
  });
});

describe('suppressionForCommand — one resolution for every CLI', () => {
  it('uses --suppression-list when given', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'custom.csv');
    fs.writeFileSync(p, LIST_CSV, 'utf8');
    const list = suppressionForCommand({ 'suppression-list': p }, path.join(dir, 'elsewhere', 'out.csv'));
    expect(list.sourcePath).toBe(p);
  });

  it('auto-discovers suppression.csv next to the anchor path', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'suppression.csv'), LIST_CSV, 'utf8');
    const list = suppressionForCommand({}, path.join(dir, 'judged.jsonl'));
    expect(list.sourcePath).toBe(path.join(dir, 'suppression.csv'));
  });

  it('rejects a bare --suppression-list with no value instead of silently running unprotected', () => {
    const dir = tmpDir();
    expect(() => suppressionForCommand({ 'suppression-list': true }, path.join(dir, 'out.csv'))).toThrow(/suppression-list/);
  });
});
