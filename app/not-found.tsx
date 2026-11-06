import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-5 text-center">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">That page doesn&apos;t exist</h1>
        <p className="mt-2 text-slate">The patient or page may have moved.</p>
        <Link href="/" className="mt-5 inline-block rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white">Back to search</Link>
      </div>
    </main>
  );
}
