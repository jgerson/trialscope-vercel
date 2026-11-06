import { SignUp } from "@clerk/nextjs";
import { AuthFrame } from "@/components/auth-frame";

export const metadata = { title: "Sign up" };

export default function SignUpPage() {
  return <AuthFrame><SignUp /></AuthFrame>;
}
