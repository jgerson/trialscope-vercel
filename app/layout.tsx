import type { Metadata, Viewport } from "next";
import "@fontsource-variable/public-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TrialScope", template: "%s · TrialScope" },
  description: "Search patient notes, PubMed and ClinicalTrials.gov in one place. A personal learning project built on turbopuffer.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#F4F6F8" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
