// Real geographic outlines used by the Italia map view.
// Italy regions (svg-maps, MIT) — viewBox 0 0 610 793.
// Veneto provinces — viewBox 0 0 600 463.
import italy from './geo/italy-regions.json';
import veneto from './geo/veneto-provinces.json';

export interface GeoLocation {
  id: string;
  name: string;
  path: string;
}
export interface GeoMap {
  viewBox: string;
  locations: GeoLocation[];
}

export const ITALY_REGIONS: GeoMap = italy as GeoMap;
export const VENETO_PROVINCES: GeoMap = veneto as GeoMap;
