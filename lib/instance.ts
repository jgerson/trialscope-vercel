// Which server instance handled a request, and whether it was that instance's first one (a cold start). Kept on
// globalThis so every route bundled into the same function instance shares it.
import "server-only";

const g = globalThis as typeof globalThis & { __bootedAt?: number; __served?: number };
g.__bootedAt ??= Date.now();

export interface InstanceInfo {
  /** This request was the first this instance served: it paid for starting the function. */
  cold: boolean;
  /** Seconds since this instance started. */
  ageS: number;
  /** Requests this instance has served, this one included. */
  served: number;
}

export function instanceInfo(): InstanceInfo {
  g.__served = (g.__served ?? 0) + 1;
  return { cold: g.__served === 1, ageS: Math.round((Date.now() - g.__bootedAt!) / 1000), served: g.__served };
}
