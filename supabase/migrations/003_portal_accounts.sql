-- 003: contact email on profiles; advisor powers require the 6-digit code (MFA, aal2)

alter table public.profiles add column if not exists contact_email text;

-- The advisor only counts as advisor once she has passed her authenticator code this session.
-- (The admin console still works as before: it does not go through this check.)
create or replace function public.is_advisor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'advisor')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

-- lets the studio know a signed-in user is the advisor (before the code step) without exposing anything else
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role::text from public.profiles where id = auth.uid();
$$;
grant execute on function public.my_role() to authenticated;
