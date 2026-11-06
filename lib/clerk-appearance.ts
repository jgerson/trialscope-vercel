// Clerk's components restyled with TrialScope's tokens (app/globals.css), so sign-in, sign-up and the account
// menu read as part of the app. Hex values mirror the CSS tokens because Clerk derives shades from them.
import type { ComponentProps } from "react";
import type { ClerkProvider } from "@clerk/nextjs";

type ProviderProps = ComponentProps<typeof ClerkProvider>;

const INK = "#080503";
const INK_2 = "#2B241E";
const SLATE = "#5E534A";
const LINE_2 = "#D3CFC6";
const SURFACE = "#FFFFFF";
const SANS = 'var(--font-instrument-sans), "Instrument Sans", ui-sans-serif, system-ui, sans-serif';
const MONO = 'var(--font-jetbrains-mono), "JetBrains Mono", ui-monospace, monospace';

export const clerkAppearance: ProviderProps["appearance"] = {
  variables: {
    colorPrimary: INK,
    colorPrimaryForeground: SURFACE,
    colorForeground: INK,
    colorMutedForeground: SLATE,
    colorNeutral: INK,
    colorBackground: SURFACE,
    colorInput: SURFACE,
    colorInputForeground: INK,
    // The darker of the two border tokens: Clerk draws input and button outlines from this, and the lighter one
    // disappears on white.
    colorBorder: LINE_2,
    colorRing: INK_2,
    colorDanger: "#B42318",
    fontFamily: SANS,
    fontFamilyButtons: SANS,
    fontFamilyMono: MONO,
    borderRadius: "0.625rem",
  },
  options: {
    // The page frame already shows the TrialScope mark and name, so Clerk's logo would repeat it.
    logoPlacement: "none",
    socialButtonsVariant: "blockButton",
  },
  // Clerk injects unlayered styles, which beat Tailwind's layered utilities, so each override here
  // carries Tailwind's important suffix (`!`). Only the properties being changed are marked.
  elements: {
    rootBox: "w-full!",
    // Flat like the app's panels: a hairline border instead of Clerk's raised shadow.
    cardBox: "w-full! max-w-none! rounded-2xl! border! border-line! shadow-none!",
    card: "bg-surface! shadow-none!",
    headerTitle: "font-display! text-[30px]! font-normal! leading-none! tracking-tight! text-ink!",
    headerSubtitle: "text-[14px]! text-slate!",
    formButtonPrimary: "shadow-none! hover:bg-ink-2!",
    // Clerk outlines these with a faint shadow; a real 1px border in the darker line token reads better on white.
    formFieldInput: "border! border-line-2! shadow-none! focus:border-ink-2!",
    socialButtonsBlockButton: "border! border-line-2! shadow-none! hover:bg-paper!",
    footer: "bg-paper! bg-none!",
    footerActionLink: "font-semibold! text-ink! underline! underline-offset-2!",
    userButtonPopoverCard: "rounded-2xl! border! border-line! shadow-pop!",
  },
};

// Shorter first-step headers: the frame's large "TrialScope" heading already names the app.
// Later steps ("Check your email", password reset) keep Clerk's own wording.
export const clerkLocalization: ProviderProps["localization"] = {
  signIn: { start: { title: "Sign in", subtitle: "Welcome back." } },
  signUp: { start: { title: "Create your account", subtitle: "It takes less than a minute." } },
};
