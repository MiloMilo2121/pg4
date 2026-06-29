import { ReasonCode } from '../types/output';

export class Pg4Error extends Error {
  public readonly reasonCode: ReasonCode;
  public readonly stage?: string;
  public readonly provider?: string;

  constructor(
    message: string,
    opts: { reasonCode: ReasonCode; stage?: string; provider?: string; cause?: unknown }
  ) {
    super(message);
    this.name = 'Pg4Error';
    this.reasonCode = opts.reasonCode;
    this.stage = opts.stage;
    this.provider = opts.provider;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Map a thrown error / network exception to a canonical reason_code. */
export function classifyError(err: unknown): ReasonCode {
  if (err instanceof Pg4Error) return err.reasonCode;
  const msg = `${(err as Error)?.message ?? err}`.toLowerCase();
  if (msg.includes('timeout') || msg.includes('etimedout')) return ReasonCode.ERROR_TIMEOUT_FETCH;
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('captcha') || msg.includes('blocked')) return ReasonCode.ERROR_BLOCKED_403;
  if (msg.includes('enotfound') || msg.includes('dns')) return ReasonCode.ERROR_DNS;
  if (msg.includes('429') || msg.includes('rate limit')) return ReasonCode.ERROR_PROVIDER_RATE_LIMIT;
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('socket')) return ReasonCode.ERROR_FETCH;
  return ReasonCode.ERROR_INTERNAL;
}
