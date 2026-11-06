// Coordinates for every town the synthetic-patient generator uses (trialscope-demo ingest/patients.py, PLACES),
// so distances to trial sites need no geocoding service. Westchester is a county; its point is near the center.

const PLACES: Record<string, [number, number]> = {
  "Westchester, NY": [41.12, -73.79],
  "White Plains, NY": [41.034, -73.763],
  "Yonkers, NY": [40.931, -73.899],
  "Stamford, CT": [41.053, -73.539],
  "Hackensack, NJ": [40.886, -74.043],
  "Bronx, NY": [40.845, -73.865],
  "Brooklyn, NY": [40.678, -73.944],
  "Manhattan, NY": [40.783, -73.971],
  "Newark, NJ": [40.736, -74.172],
  "Boston, MA": [42.36, -71.059],
  "Philadelphia, PA": [39.953, -75.165],
  "Baltimore, MD": [39.29, -76.612],
  "Cleveland, OH": [41.499, -81.694],
  "Chicago, IL": [41.878, -87.63],
  "Houston, TX": [29.76, -95.369],
  "Denver, CO": [39.739, -104.99],
  "Seattle, WA": [47.606, -122.332],
  "Atlanta, GA": [33.749, -84.388],
};

/** [lat, lon] for a patient's town, or null for a town not in the generator's list. */
export function placeCoords(city: string, state: string): [number, number] | null {
  return PLACES[`${city}, ${state}`] ?? null;
}

/** Great-circle distance in miles. */
export function milesBetween(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}
