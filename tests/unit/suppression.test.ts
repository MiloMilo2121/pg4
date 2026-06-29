import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SuppressionList } from '../../src/compliance/suppression';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-suppr-'));
}

const LIST_CSV = `phone,vat,reason,date
+390422000177,,operator_request,2026-06-01
,01234567897,gdpr_deletion,2026-05-20
348 0000591,,bounce_complaint,2026-04-10
`;

describe('SuppressionList — Phase D.1', () => {
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
