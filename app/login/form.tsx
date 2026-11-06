"use client";
import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { signIn } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} className="mt-7 rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgb(14_26_36/0.04)]">
      <label htmlFor="password" className="text-[13px] font-medium text-ink">Password</label>
      <input id="password" name="password" type="password" autoFocus required autoComplete="current-password"
        className="mt-1.5 block h-11 w-full rounded-xl border border-line bg-paper px-3.5 text-[15px] focus:border-accent focus:ring-4 focus:ring-accent/10 focus:outline-none" />
      {state?.error && <p role="alert" className="mt-2 text-[13px] text-red-700">{state.error}</p>}
      <button disabled={pending}
        className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[14.5px] font-semibold text-white hover:bg-ink-2 disabled:opacity-70">
        {pending && <Loader2 size={16} className="animate-spin" />}Sign in
      </button>
    </form>
  );
}
