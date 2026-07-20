import { describe, expect, it } from 'vitest';
import { browserSessionId } from '../../src/discovery/scrape_pipeline';

describe('scrape target ownership', () => {
  it('keeps browser storage stable per output target and isolated across cells', () => {
    const pd = browserSessionId('output/campaign/pd_raw.csv', 'agenzie immobiliari');
    const pdResume = browserSessionId('output/campaign/pd_raw.csv', 'agenzie immobiliari');
    const vr = browserSessionId('output/campaign/vr_raw.csv', 'agenzie immobiliari');

    expect(pd).toBe(pdResume);
    expect(pd).not.toBe(vr);
  });
});
