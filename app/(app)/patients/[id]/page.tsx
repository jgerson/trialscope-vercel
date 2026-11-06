import { notFound } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { getPatient } from "@/lib/patients";
import { listNotes } from "@/lib/tpuf";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const p = await getPatient((await params).id);
  return { title: p?.name ?? "Patient" };
}

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patient = await getPatient(id);
  if (!patient) notFound();
  const notes = await listNotes(id);
  return <Workspace patient={patient} initialNotes={notes} />;
}
