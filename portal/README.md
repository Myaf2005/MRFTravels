# MRF Travels client portal

- `/portal/` — client sign-in and trip portal
- `/portal/studio/` — Mya's Advisor Studio (password + authenticator code)

Data, logins and files live in Supabase (project "MRF Client Portal"). The browser only
uses the publishable key; every table is protected by row-level security.

- `supabase/migrations/` — database setup, already applied in Supabase
- `supabase/functions/portal-accounts/` — the only code that can create or change logins
  (deployed in Supabase → Edge Functions → portal-accounts)
