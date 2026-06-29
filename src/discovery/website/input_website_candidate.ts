import type { AssessedWebsite, WebsiteClassification } from '../../types/discovery';
import { isDirectoryOrSocial } from './content_filter';

const MESSAGING_OR_REDIRECT_HOSTS = new Set([
  'wa.me', 'whatsapp.com', 'api.whatsapp.com', 'chat.whatsapp.com',
  't.me', 'telegram.me', 'linktr.ee', 'bit.ly', 'tinyurl.com',
]);

/**
 * Classifies a raw input URL and generates URL variants to try
 * (https/http × www/no-www × path/no-path × registrable host).
 *
 * Ported from pg3/foundation/InputWebsiteCandidate.ts with the ContentFilter
 * dependency inverted to a pure function import.
 */
export class InputWebsiteCandidate {
  static assess(rawUrl?: string): AssessedWebsite {
    const normalized = this.normalize(rawUrl);
    if (!normalized) {
      return {
        classification: 'INVALID',
        candidates: [],
        reason_code: rawUrl ? 'INPUT_WEBSITE_INVALID' : undefined,
      };
    }

    if (this.isMessagingOrRedirect(normalized)) {
      return {
        classification: 'MESSAGING_OR_REDIRECT',
        normalized_url: normalized,
        candidates: [],
        reason_code: 'INPUT_WEBSITE_MESSAGING_OR_REDIRECT',
      };
    }

    if (isDirectoryOrSocial(normalized)) {
      return {
        classification: 'DIRECTORY_OR_SOCIAL',
        normalized_url: normalized,
        candidates: [],
        reason_code: 'INPUT_WEBSITE_DIRECTORY_OR_SOCIAL',
      };
    }

    return {
      classification: 'VALID' as WebsiteClassification,
      normalized_url: normalized,
      candidates: this.buildCandidates(normalized),
    };
  }

  private static normalize(rawUrl?: string): string | undefined {
    if (!rawUrl || !rawUrl.trim()) return undefined;
    const trimmed = rawUrl.trim();
    const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
    try {
      const parsed = new URL(withProtocol);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      if (!this.isLikelyValidHostname(parsed.hostname)) return undefined;
      parsed.hash = '';
      parsed.search = '';
      parsed.username = '';
      parsed.password = '';
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
      const port = parsed.port ? `:${parsed.port}` : '';
      return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
    } catch {
      return undefined;
    }
  }

  private static isLikelyValidHostname(hostname: string): boolean {
    const labels = hostname.toLowerCase().split('.').map((s) => s.trim()).filter(Boolean);
    if (labels.length < 2) return false;
    for (const label of labels) {
      if (!/^[a-z0-9-]{1,63}$/i.test(label) || label.startsWith('-') || label.endsWith('-')) return false;
    }
    const tld = labels[labels.length - 1];
    return /^[a-z]{2,24}$/i.test(tld);
  }

  private static isMessagingOrRedirect(url: string): boolean {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return MESSAGING_OR_REDIRECT_HOSTS.has(h);
    } catch {
      return false;
    }
  }

  private static buildCandidates(normalized: string): string[] {
    const parsed = new URL(normalized);
    const hostNoWww = parsed.hostname.replace(/^www\./, '');
    const registrable = this.toRegistrable(hostNoWww);
    const path = parsed.pathname || '';
    const hasPath = path !== '' && path !== '/';
    const seen = new Set<string>();
    const out: string[] = [];

    const push = (proto: string, host: string, includePath: boolean) => {
      const base = `${proto}//${host}${parsed.port ? `:${parsed.port}` : ''}`;
      const candidate = includePath && hasPath ? `${base}${path}` : base;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    };

    push(parsed.protocol, parsed.hostname, true);
    push(parsed.protocol, parsed.hostname, false);
    if (parsed.protocol === 'http:') {
      push('https:', parsed.hostname, true);
      push('https:', parsed.hostname, false);
    }
    if (hostNoWww !== parsed.hostname) {
      push(parsed.protocol, hostNoWww, true);
      push(parsed.protocol, hostNoWww, false);
      if (parsed.protocol === 'http:') {
        push('https:', hostNoWww, true);
        push('https:', hostNoWww, false);
      }
    } else if (hostNoWww.includes('.')) {
      const wwwHost = `www.${hostNoWww}`;
      push(parsed.protocol, wwwHost, false);
      if (parsed.protocol === 'http:') push('https:', wwwHost, false);
    }
    if (registrable && registrable !== hostNoWww) {
      push(parsed.protocol, registrable, false);
      if (parsed.protocol === 'http:') push('https:', registrable, false);
      const wwwReg = `www.${registrable}`;
      push(parsed.protocol, wwwReg, false);
      if (parsed.protocol === 'http:') push('https:', wwwReg, false);
    }
    return out;
  }

  private static toRegistrable(hostname: string): string | undefined {
    const labels = hostname.split('.').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (labels.length < 3) return hostname;
    const cc2L = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);
    const last = labels[labels.length - 1];
    const penult = labels[labels.length - 2];
    if (last.length === 2 && cc2L.has(penult) && labels.length >= 3) return labels.slice(-3).join('.');
    return labels.slice(-2).join('.');
  }
}
