import { notFound } from "next/navigation";
import { TrialView } from "@/components/trial-view";
import { getTrial } from "@/lib/ctgov";

export async function generateMetadata({ params }: { params: Promise<{ nct: string }> }) {
  return { title: (await params).nct };
}

// A trial read live from ClinicalTrials.gov: the eligibility checklist and the sites near the selected patient.
export default async function TrialPage({ params }: { params: Promise<{ nct: string }> }) {
  const { nct } = await params;
  let trial;
  try {
    trial = await getTrial(nct.toUpperCase());
  } catch {
    return (
      <div className="mx-auto max-w-md p-10 text-sm text-slate">
        <h1 className="mb-2 text-lg font-semibold text-ink">ClinicalTrials.gov didn&apos;t respond</h1>
        The trial record couldn&apos;t be loaded just now. Reload the page to try again.
      </div>
    );
  }
  if (!trial) notFound();
  return <TrialView trial={trial} />;
}
