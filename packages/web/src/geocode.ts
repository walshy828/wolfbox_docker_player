/**
 * Reverse-geocodes one GPS fix into a short place name, via the server's
 * `/api/geocode` proxy -- see `server/app.py` for why this is not called
 * directly from the browser.
 *
 * Cached in memory by rounded coordinate so revisiting the same driveway
 * across many trips in one session never asks twice, matching the server's
 * own on-disk cache.
 */

const PRECISION = 4; // ~11 m; matches the server's cache rounding.

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

const key = (lat: number, lon: number): string =>
  `${lat.toFixed(PRECISION)},${lon.toFixed(PRECISION)}`;

export async function reverseGeocode(
  lat: number, lon: number, signal?: AbortSignal,
): Promise<string | null> {
  const cacheKey = key(lat, lon);
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`, { signal });
        if (!response.ok) return null;
        const payload = await response.json() as { label: string | null };
        return payload.label;
      } catch {
        return null;
      }
    })();
    inFlight.set(cacheKey, pending);
    void pending.finally(() => inFlight.delete(cacheKey));
  }

  const label = await pending;
  // A lookup one caller aborted may still be in flight for another; only the
  // successful, unaborted result is worth remembering.
  if (!signal?.aborted) cache.set(cacheKey, label);
  return label;
}
