// One table for navigation: the sidebar, the topbar path, the command palette
// and the `g` + key shortcuts all read it, so they can never disagree.
import type { Nav } from './data';
import type { IconName } from '../ds/components/Icon';

export interface NavItem {
  id: Nav;
  label: string;
  icon: IconName;
  /** Second key of the `g` + key shortcut. */
  key: string;
  /** Path segment shown in the topbar ("archivio"). */
  path: string;
}

export const NAV_GROUPS: { num: string; label: string; items: NavItem[] }[] = [
  { num: '01', label: 'Cockpit', items: [{ id: 'home', label: 'Panoramica', icon: 'cockpit', key: 'h', path: 'cockpit' }] },
  {
    num: '02', label: 'Mercati e territorio', items: [
      { id: 'mercati', label: 'Dataset', icon: 'dataset', key: 'd', path: 'mercati' },
      { id: 'aziende', label: 'Aziende', icon: 'companies', key: 'a', path: 'archivio' },
      { id: 'italia', label: 'Mappa Italia', icon: 'map', key: 'm', path: 'italia' },
    ],
  },
  {
    num: '03', label: 'Raffinazione', items: [
      { id: 'raff', label: 'Arricchimento e imbuto', icon: 'funnel', key: 'r', path: 'raffinazione' },
      { id: 'val', label: 'Valutazione', icon: 'matrix', key: 'v', path: 'valutazione' },
    ],
  },
  { num: '04', label: 'Intelligence', items: [{ id: 'analytics', label: 'Analytics', icon: 'analytics', key: 'n', path: 'intelligence' }] },
  {
    num: '05', label: 'Sistema', items: [
      { id: 'sistema', label: 'Run e crediti', icon: 'system', key: 's', path: 'sistema' },
      { id: 'liste', label: 'Liste finali', icon: 'lists', key: 'l', path: 'output' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
export const navItem = (id: Nav): NavItem => NAV_ITEMS.find((n) => n.id === id) ?? NAV_ITEMS[0];
