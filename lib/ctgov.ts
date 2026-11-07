// One trial, fetched live from the ClinicalTrials.gov API for the trial page. The turbopuffer index keeps eligibility
// criteria only inside its search text, cut to 2,500 characters, and stores countries but not sites, so the eligibility
// checklist and the sites map read the full, current record from the source instead (no schema change).
import "server-only";

export interface Site {
  facility: string;
  city: string;
  state: string;
  country: string;
  status: string; // RECRUITING, NOT_YET_RECRUITING, COMPLETED, ...
  lat: number | null;
  lon: number | null;
}

export interface Trial {
  nct: string;
  title: string;
  status: string;
  phases: string[];
  conditions: string[];
  sponsor: string;
  criteria: string;
  minAge: string;
  maxAge: string;
  sex: string;
  sites: Site[];
  fetchedAt: string;
}

export const NCT_RE = /^NCT\d{8}$/;

const FIELDS = [
  "NCTId", "BriefTitle", "OverallStatus", "Phase", "Condition", "LeadSponsorName",
  "EligibilityCriteria", "MinimumAge", "MaximumAge", "Sex",
  "LocationFacility", "LocationCity", "LocationState", "LocationCountry", "LocationStatus", "LocationGeoPoint",
].join(",");

const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The trial, or null when the id is malformed or ClinicalTrials.gov has no such study. Cached for an hour. */
export async function getTrial(nct: string): Promise<Trial | null> {
  if (!NCT_RE.test(nct)) return null;
  const res = await fetch(`https://clinicaltrials.gov/api/v2/studies/${nct}?fields=${FIELDS}`, {
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ClinicalTrials.gov returned ${res.status}`);
  // External data: read every field defensively.
  const p = ((await res.json()) as { protocolSection?: Record<string, Record<string, unknown>> }).protocolSection ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const elig = p.eligibilityModule ?? {};
  const locations = (p.contactsLocationsModule?.locations as Record<string, unknown>[] | undefined) ?? [];
  return {
    nct,
    title: str(p.identificationModule?.briefTitle) || nct,
    status: pretty(str(p.statusModule?.overallStatus) || "UNKNOWN"),
    phases: ((p.designModule?.phases as string[] | undefined) ?? []).map((x) => x.replace("PHASE", "Phase ").replace("EARLY_", "Early ")),
    conditions: ((p.conditionsModule?.conditions as string[] | undefined) ?? []).slice(0, 12),
    sponsor: str((p.sponsorCollaboratorsModule?.leadSponsor as Record<string, unknown> | undefined)?.name),
    criteria: str(elig.eligibilityCriteria).trim(),
    minAge: str(elig.minimumAge) || "None",
    maxAge: str(elig.maximumAge) || "None",
    sex: pretty(str(elig.sex) || "ALL"),
    sites: locations.map((l) => {
      const g = (l.geoPoint ?? {}) as { lat?: unknown; lon?: unknown };
      return {
        facility: str(l.facility), city: str(l.city), state: str(l.state), country: str(l.country), status: str(l.status) || "UNKNOWN",
        lat: typeof g.lat === "number" ? g.lat : null, lon: typeof g.lon === "number" ? g.lon : null,
      };
    }),
    fetchedAt: new Date().toISOString(),
  };
}
