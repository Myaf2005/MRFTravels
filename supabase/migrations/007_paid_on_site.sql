-- 007: costs paid at the destination (cash on the day, paid on board, on arrival)
alter table public.payments add column if not exists paid_on_site boolean not null default false;
update public.payments set paid_on_site = true
  where received = false and (name ilike '%cash on the day%' or name ilike '%paid on board%' or name ilike '%on arrival%');
select name, paid_on_site from public.payments where paid_on_site order by name;
