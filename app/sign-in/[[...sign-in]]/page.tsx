import { SignIn } from "@clerk/nextjs";
import { AuthFrame } from "@/components/auth-frame";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  // withSignUp={false}: with no sign-up page configured, Clerk otherwise turns this form into a combined
  // "sign in or sign up" flow, where an unknown email would create a new account.
  return <AuthFrame><SignIn withSignUp={false} /></AuthFrame>;
}
