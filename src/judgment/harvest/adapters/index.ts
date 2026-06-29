import type { SourceAdapter } from '../source_harvest';
import { WebsiteSourceAdapter } from './website_adapter';
import { RegistrySourceAdapter } from './registry_adapter';
import { PlacesSourceAdapter } from './places_adapter';
import { SocialSourceAdapter } from './social_adapter';
import { AdLibrarySourceAdapter } from './ad_library_adapter';

export { WebsiteSourceAdapter } from './website_adapter';
export { RegistrySourceAdapter } from './registry_adapter';
export { PlacesSourceAdapter } from './places_adapter';
export { SocialSourceAdapter } from './social_adapter';
export { AdLibrarySourceAdapter } from './ad_library_adapter';

/**
 * The default source-adapter set. Each is behind `available()`; only the website
 * adapter runs unconditionally (free, offline). The rest are wired-but-disabled
 * until their key/flag is set — the project's free-first, paid-gate-OFF posture.
 */
export function defaultSourceAdapters(): SourceAdapter[] {
  return [new WebsiteSourceAdapter(), new RegistrySourceAdapter(), new PlacesSourceAdapter(), new SocialSourceAdapter(), new AdLibrarySourceAdapter()];
}

export function sourceAdaptersByKind(): Record<string, SourceAdapter> {
  const out: Record<string, SourceAdapter> = {};
  for (const a of defaultSourceAdapters()) out[a.kind] = a;
  return out;
}
