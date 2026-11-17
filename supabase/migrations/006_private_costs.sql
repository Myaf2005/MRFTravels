-- 006: per-traveler visibility inside a shared trip.
-- payments.visible_to / documents.visible_to: NULL or empty = everyone on the trip; otherwise only those client ids.
-- Receipts follow their payment. Client uploads ("Your documents") are visible only to the uploader (and Mya).

alter table public.payments  add column if not exists visible_to uuid[];
alter table public.documents add column if not exists visible_to uuid[];

create or replace function public.can_see_item(t uuid, vis uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_advisor()
      or (public.is_trip_member(t) and (vis is null or cardinality(vis) = 0 or auth.uid() = any (vis)));
$$;
grant execute on function public.can_see_item(uuid, uuid[]) to authenticated;

drop policy if exists "payments: members read" on public.payments;
create policy "payments: members read" on public.payments for select to authenticated
  using (public.can_see_item(trip_id, visible_to));

drop policy if exists "docs: members read" on public.documents;
create policy "docs: members read" on public.documents for select to authenticated
  using (public.can_see_item(trip_id, visible_to));

-- a client's own upload is private to them; clients can never choose who sees a document
create or replace function public.docs_set_visibility() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_advisor() and coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.visible_to := array[auth.uid()];
  end if;
  return new;
end $$;
drop trigger if exists docs_set_visibility on public.documents;
create trigger docs_set_visibility before insert or update on public.documents
  for each row execute function public.docs_set_visibility();

update public.documents set visible_to = array[uploaded_by]
  where category = 'client' and uploaded_by is not null and visible_to is null;

-- a payment's receipt is seen by exactly the people who see the payment
create or replace function public.payments_sync_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.receipt_document_id is not null then
    update public.documents set visible_to = new.visible_to where id = new.receipt_document_id;
  end if;
  return new;
end $$;
drop trigger if exists payments_sync_receipt on public.payments;
create trigger payments_sync_receipt after insert or update of visible_to, receipt_document_id on public.payments
  for each row execute function public.payments_sync_receipt();

-- files follow their document's visibility
create or replace function public.can_read_file(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_advisor() or exists (
    select 1 from public.documents d where d.storage_path = p and public.can_see_item(d.trip_id, d.visible_to));
$$;
grant execute on function public.can_read_file(text) to authenticated;

drop policy if exists "files: members read" on storage.objects;
create policy "files: members read" on storage.objects for select to authenticated
  using (bucket_id = 'trip-files' and public.can_read_file(name));
