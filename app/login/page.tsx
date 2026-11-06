import { redirect } from "next/navigation";
import { LoginForm } from "./form";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default function LoginPage() {
  if (!process.env.APP_PASSWORD) redirect("/");
  return (
    <main className="grid min-h-dvh place-items-center px-5">
      <div className="w-full max-w-[400px]">
        <svg width="40" height="40" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"
          strokeLinejoin="round" aria-hidden="true" className="text-accent">
          <circle cx="15" cy="15" r="10" /><path d="M29 29l-6.8-6.8" /><path d="M15 10.5v9M10.5 15h9" />
        </svg>
        <h1 className="mt-5 text-[32px] font-bold tracking-[-0.03em]">TrialScope</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-slate">Search patient notes, PubMed and ClinicalTrials.gov in one place.</p>
        <LoginForm />
        <p className="mt-5 text-[12.5px] leading-relaxed text-slate">A personal learning project. Every patient is synthetic; not for clinical use.</p>
      </div>
    </main>
  );
}
