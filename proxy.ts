// Runs before every request: everything except Clerk's sign-in and sign-up pages needs a signed-in user.
// Pages redirect to the app's /sign-in; API routes get a 404 from auth.protect() (and a 401 from their own check).
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublic = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublic(req)) await auth.protect();
  },
  // Without these, auth.protect() sends signed-out visitors to Clerk's hosted page instead of the app's own,
  // styled /sign-in. ClerkProvider in app/layout.tsx is given the same paths.
  { signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
