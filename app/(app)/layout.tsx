import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { config, copilotEnabled } from "@/lib/config";
import { getPatients } from "@/lib/patients";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!config.tpufKey) {
    return (
      <div className="mx-auto max-w-md p-10 text-sm text-slate">
        <h1 className="mb-2 text-lg font-semibold text-ink">Almost there</h1>
        Add <code className="font-mono">TURBOPUFFER_API_KEY</code> to the project&apos;s environment variables and redeploy.
      </div>
    );
  }
  const [patients, jar] = await Promise.all([getPatients(), cookies()]);
  return (
    <AppShell patients={patients} initialPatientId={jar.get("ts_patient")?.value ?? null}
      copilotEnabled={copilotEnabled} readOnly={config.readOnly} fulltextEnabled={config.fulltextEnabled}>
      {children}
    </AppShell>
  );
}
