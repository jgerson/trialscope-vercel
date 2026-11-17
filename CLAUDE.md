# Conventions for this repo

- This is a personal learning project. Keep the README's personal-project and not-for-clinical-use notes.
- Do not include Claude-Session links in commit messages or PR descriptions.
- Never commit keys. Settings come from environment variables (`.env.local` locally, Vercel project settings in production).
- The turbopuffer namespaces (`ts-trials`, `ts-pubmed`, `ts-patients`, `ts-patient-*`) are shared with the Streamlit app; don't change their schemas.
- `ts-patient-*` (each patient's notes) is also read and written by TrialScope Match (jgerson/trialscope-match), so a note saved in either app shows up in both. Its schema is pinned in both repos (`NOTE_SCHEMA` here, `lib/notes.ts` there).
