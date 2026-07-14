import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Redacted, bounded browser evidence for diagnosis. Never persists page HTML. */
export interface PageEvidence {
  fingerprint?: string;
  title?: string;
  screenshot_path?: string;
}

export async function capturePageEvidence(
  page: import('playwright').Page | undefined,
  diagnosticsDir: string | undefined,
  key: string,
): Promise<PageEvidence> {
  if (!page || page.isClosed()) return {};
  const result: PageEvidence = {};
  try {
    result.title = await page.title();
    const content = await page.content();
    result.fingerprint = crypto.createHash('sha256').update(`${result.title}\n${content.slice(0, 50_000)}`).digest('hex').slice(0, 24);
  } catch {
    // A browser teardown is itself useful context, but must not hide the run failure.
  }
  if (diagnosticsDir) {
    try {
      fs.mkdirSync(diagnosticsDir, { recursive: true });
      const safeKey = key.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 120);
      const screenshotPath = path.join(diagnosticsDir, `${safeKey}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      result.screenshot_path = screenshotPath;
    } catch {
      // Screenshot capture is optional evidence, never a new failure mode.
    }
  }
  return result;
}
