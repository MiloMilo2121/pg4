import type { IncomingHttpHeaders } from 'http';
import type { Readable } from 'stream';

/**
 * JSON body reader for the local dev API. Every POST body here is a small
 * selection (ids, fields, one category/province), so 1 MB is generous; the cap
 * stops a stray client from making the server buffer an unbounded string.
 */
const MAX_BODY_BYTES = 1024 * 1024;

export type BodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

type BodySource = Readable & { headers: IncomingHttpHeaders };

export function readJsonBody(req: BodySource, limit = MAX_BODY_BYTES): Promise<BodyResult> {
  const tooLarge: BodyResult = { ok: false, status: 413, error: `request body exceeds ${limit} bytes` };
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.resolve(tooLarge);

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (result: BodyResult): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        // Stop pulling: the caller answers 413 and closes the connection, which
        // discards whatever the client is still sending.
        req.pause();
        finish(tooLarge);
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void => finish(parseJsonObject(Buffer.concat(chunks).toString('utf8')));
    const onError = (): void => finish({ ok: false, status: 400, error: 'request body could not be read' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseJsonObject(raw: string): BodyResult {
  if (!raw.trim()) return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: 'request body is not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, status: 400, error: 'request body must be a JSON object' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
