import * as dns from 'dns';

export interface DnsResolutionResult {
  domain: string;
  alive: boolean;
  ip?: string;
}

/**
 * Resolves a batch of candidate domains via DNS A-record lookup. Used after
 * the generator to keep only domains that exist (registered + with A record).
 *
 * Concurrency is bounded to avoid EMFILE / DNS flood. Pure (modulo DNS).
 */
export class HyperGuesserResolver {
  static async resolveBatch(
    domains: string[],
    opts: { maxConcurrency?: number; resolve4?: (host: string) => Promise<string[]> } = {}
  ): Promise<DnsResolutionResult[]> {
    const maxConcurrency = opts.maxConcurrency ?? 30;
    const resolver = opts.resolve4 ?? dns.promises.resolve4;
    const out: DnsResolutionResult[] = [];

    for (let i = 0; i < domains.length; i += maxConcurrency) {
      const chunk = domains.slice(i, i + maxConcurrency);
      const settled = await Promise.all(
        chunk.map(async (d) => this.checkOne(d, resolver))
      );
      for (const r of settled) out.push(r);
    }
    return out.filter((r) => r.alive);
  }

  private static async checkOne(
    domain: string,
    resolver: (host: string) => Promise<string[]>
  ): Promise<DnsResolutionResult> {
    try {
      const addrs = await resolver(domain);
      if (addrs && addrs.length > 0) return { domain, alive: true, ip: addrs[0] };
      return { domain, alive: false };
    } catch {
      return { domain, alive: false };
    }
  }
}
