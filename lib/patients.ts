// Cached patient directory lookups for server components and routes.
import "server-only";
import { cache } from "react";
import { listPatients } from "./tpuf";
import type { Patient } from "./types";

export const getPatients = cache(async (): Promise<Patient[]> => listPatients());

export async function getPatient(id: string | undefined | null): Promise<Patient | null> {
  if (!id) return null;
  return (await getPatients()).find((p) => p.id === id) ?? null;
}
