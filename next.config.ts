import type { NextConfig } from "next";

// Production aliases on vercel.app. Clerk's production keys only work on trialscope.space, so sign-in can't
// succeed on these; send visitors to the real domain instead. Per-deployment and preview URLs are untouched
// (they sit behind Vercel's own login and use Clerk's development keys).
const OLD_HOSTS = ["trialscope-vercel.vercel.app", "trialscope-vercel-jgerson.vercel.app"];
const SITE = "https://www.trialscope.space";

const securityHeaders = [
  // Nobody may embed the app in a frame (clickjacking). frame-ancestors is the modern form, X-Frame-Options the fallback.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  // Browsers must trust declared content types instead of guessing them.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Other sites see only the origin, never full paths such as /patients/<id>.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app uses none of these browser features.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    return OLD_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: host }],
      destination: `${SITE}/:path*`,
      permanent: true,
    }));
  },
};

export default nextConfig;
