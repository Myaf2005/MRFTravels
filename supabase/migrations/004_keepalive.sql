-- 004: keep-alive ping for the free plan (returns only the time; no client data)
create or replace function public.keepalive() returns text
language sql stable security definer set search_path = public as $$
  select 'ok ' || now()::text;
$$;
revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;
