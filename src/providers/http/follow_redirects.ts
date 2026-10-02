import { request, type Dispatcher } from 'undici';

/** Derived from the call itself so it tracks whatever undici's `request` accepts. */
type RequestOptions = NonNullable<Parameters<typeof request>[1]>;

/** How many redirects a caller is willing to follow. */
const MAX_REDIRECTS = 5;

export interface FollowOptions {
  method?: 'GET' | 'POST';
  /** Re-sent on 307/308 only; see the method-downgrade note below. */
  body?: string;
  /** Called per hop, because a redirect can change host and the right headers depend on it. */
  headersFor?: (url: string) => Record<string, string>;
  headers?: Record<string, string>;
  bodyTimeout?: number;
  headersTimeout?: number;
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
  /** Re-checked on every hop. Use it whenever the URL came from scraped data. */
  assertHop?: (url: string) => void;
}

export interface FollowResult {
  response: Dispatcher.ResponseData<unknown>;
  /** The URL that produced `response` — not necessarily the one passed in. */
  finalUrl: string;
}

/**
 * A single HTTP exchange with redirects followed by hand.
 *
 * undici removed the `maxRedirections` option in v7: passing it throws
 * `maxRedirections is not supported, use the redirect interceptor`, which lands
 * in the caller's catch block and reads like a transient network failure. A
 * provider that silently degrades into "no results" is worse than one that fails
 * loudly, so the loop lives here once instead of at each call site.
 *
 * Method handling follows what a browser does, because a server that redirects
 * a POST to a login page expects the follow-up to be a GET:
 *   - 301 / 302 / 303 → downgrade to GET and drop the body
 *   - 307 / 308        → replay the original method and body
 *
 * The hop limit is a hard cap, not a hint: a redirect cycle otherwise spins
 * until the caller's timeout, spending the whole budget to reach nowhere.
 */
export async function followRedirects(url: string, opts: FollowOptions = {}): Promise<FollowResult> {
  let currentUrl = url;
  let method = opts.method ?? 'GET';
  let body = opts.body;

  for (let hop = 0; ; hop += 1) {
    opts.assertHop?.(currentUrl);

    const options: RequestOptions = {
      method,
      headersTimeout: opts.headersTimeout,
      bodyTimeout: opts.bodyTimeout,
      signal: opts.signal,
      headers: opts.headersFor ? opts.headersFor(currentUrl) : opts.headers,
    };
    if (opts.dispatcher) options.dispatcher = opts.dispatcher;
    if (body !== undefined) options.body = body;

    const res = await request(currentUrl, options);
    const location = headerValue(res.headers.location);
    if (!isRedirect(res.statusCode) || !location || hop >= MAX_REDIRECTS) {
      return { response: res, finalUrl: currentUrl };
    }

    // Discard the redirect body before the next hop, or the socket stays busy
    // and the connection cannot be reused.
    await res.body.dump();

    const next = resolveRedirect(location, currentUrl);
    if (next === undefined) return { response: res, finalUrl: currentUrl };

    currentUrl = next;
    if (res.statusCode !== 307 && res.statusCode !== 308) {
      method = 'GET';
      body = undefined;
    }
  }
}

/**
 * Resolve a `Location` header, or reject the hop.
 *
 * A redirect target is attacker-controllable whenever the starting URL is: a
 * hostile page can answer `Location: file:///etc/passwd` or
 * `Location: javascript:…`, both of which `new URL()` resolves happily and both
 * of which have no business being fetched. Only the two web schemes are allowed.
 */
function resolveRedirect(location: string, base: string): string | undefined {
  let resolved: URL;
  try {
    resolved = new URL(location, base);
  } catch {
    return undefined; // unparseable — surface the 3xx as-is
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
  return resolved.toString();
}

/** undici types a repeated header as a string array; most callers want the first. */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const first = Array.isArray(v) ? v[0] : v;
  return first.length > 0 ? first : undefined;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}
