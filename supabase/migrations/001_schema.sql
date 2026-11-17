-- MRF Travels client portal — database schema & security rules
-- Clients can only ever see trips they belong to. Only the advisor can add or change
-- trip content. Clients can tick their checklist, mark updates read, and upload/remove
-- their own files in the "client" (Your documents) category.

-- ---------- profiles & roles ----------
create type public.user_role as enum ('client', 'advisor');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null default 'client',
  full_name text not null default '',
  username text unique,
  must_set_login boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.is_advisor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'advisor');
$$;

-- every new auth user gets a profile (role defaults to client)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.raw_user_meta_data->>'username');
  return new;
end; $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- clients may edit their own username/name/setup flag, never their role
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') and not public.is_advisor()
     and new.role is distinct from old.role then
    raise exception 'Not allowed to change role';
  end if;
  return new;
end; $$;
create trigger guard_profile_update before update on public.profiles
for each row execute function public.guard_profile_update();

-- ---------- trips ----------
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  travelers text not null default '',
  start_date date,
  end_date date,
  status text not null default 'Planning' check (status in ('Planning', 'Booked', 'Traveling', 'Complete')),
  hero_image text,
  created_at timestamptz not null default now()
);

create table public.trip_members (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (trip_id, user_id)
);

create or replace function public.is_trip_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t and user_id = auth.uid());
$$;

create or replace function public.can_view_trip(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_advisor() or public.is_trip_member(t);
$$;

-- ---------- trip content ----------
create table public.itinerary_days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  day_date date,
  title text not null,
  place text not null default '',
  sort int not null default 0
);

create table public.itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  day_id uuid not null references public.itinerary_days(id) on delete cascade,
  time_label text not null default '',
  title text not null,
  note text not null default '',
  sort int not null default 0
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  category text not null check (category in ('confirmations', 'tickets', 'receipts', 'client')),
  title text not null,
  storage_path text not null unique,
  uploaded_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  kind text not null default 'other' check (kind in ('flight', 'hotel', 'transfer', 'experience', 'other')),
  name text not null,
  details text not null default '',
  confirmation_no text not null default '',
  status text not null default 'Pending' check (status in ('Pending', 'Confirmed')),
  document_id uuid references public.documents(id) on delete set null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  amount numeric(10, 2) not null default 0,
  due_date date,
  received boolean not null default false,
  receipt_document_id uuid references public.documents(id) on delete set null,
  sort int not null default 0
);

create table public.updates (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  kind text not null default 'update' check (kind in ('update', 'reminder')),
  body text not null,
  link_section text,
  link_document_id uuid references public.documents(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.update_reads (
  update_id uuid not null references public.updates(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  read_at timestamptz not null default now(),
  primary key (update_id, user_id)
);

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text not null,
  note text not null default '',
  done boolean not null default false,
  sort int not null default 0
);

-- clients may only flip "done" on their checklist
create or replace function public.guard_checklist_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') and not public.is_advisor()
     and (new.title is distinct from old.title or new.note is distinct from old.note
     or new.trip_id is distinct from old.trip_id or new.sort is distinct from old.sort) then
    raise exception 'Clients can only tick checklist items';
  end if;
  return new;
end; $$;
create trigger guard_checklist_update before update on public.checklist_items
for each row execute function public.guard_checklist_update();

-- advisor-only private to-dos
create table public.advisor_tasks (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references public.trips(id) on delete cascade,
  body text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.itinerary_days enable row level security;
alter table public.itinerary_items enable row level security;
alter table public.documents enable row level security;
alter table public.bookings enable row level security;
alter table public.payments enable row level security;
alter table public.updates enable row level security;
alter table public.update_reads enable row level security;
alter table public.checklist_items enable row level security;
alter table public.advisor_tasks enable row level security;

-- profiles
create policy "profiles: read own or advisor" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_advisor());
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles: advisor manages" on public.profiles for all to authenticated
  using (public.is_advisor()) with check (public.is_advisor());

-- trips & membership
create policy "trips: members read" on public.trips for select to authenticated using (public.can_view_trip(id));
create policy "trips: advisor manages" on public.trips for all to authenticated using (public.is_advisor()) with check (public.is_advisor());
create policy "members: read own" on public.trip_members for select to authenticated using (user_id = auth.uid() or public.is_advisor());
create policy "members: advisor manages" on public.trip_members for all to authenticated using (public.is_advisor()) with check (public.is_advisor());

-- read-only-for-clients content
create policy "days: members read" on public.itinerary_days for select to authenticated using (public.can_view_trip(trip_id));
create policy "days: advisor manages" on public.itinerary_days for all to authenticated using (public.is_advisor()) with check (public.is_advisor());
create policy "items: members read" on public.itinerary_items for select to authenticated using (public.can_view_trip(trip_id));
create policy "items: advisor manages" on public.itinerary_items for all to authenticated using (public.is_advisor()) with check (public.is_advisor());
create policy "bookings: members read" on public.bookings for select to authenticated using (public.can_view_trip(trip_id));
create policy "bookings: advisor manages" on public.bookings for all to authenticated using (public.is_advisor()) with check (public.is_advisor());
create policy "payments: members read" on public.payments for select to authenticated using (public.can_view_trip(trip_id));
create policy "payments: advisor manages" on public.payments for all to authenticated using (public.is_advisor()) with check (public.is_advisor());
create policy "updates: members read" on public.updates for select to authenticated using (public.can_view_trip(trip_id));
create policy "updates: advisor manages" on public.updates for all to authenticated using (public.is_advisor()) with check (public.is_advisor());

-- documents: clients read all of their trip's docs, but add/remove only their own "client" files
create policy "docs: members read" on public.documents for select to authenticated using (public.can_view_trip(trip_id));
create policy "docs: advisor manages" on public.documents for all to authenticated using (public.is_advisor()) with check (public.is_advisor());
create policy "docs: client adds own" on public.documents for insert to authenticated
  with check (category = 'client' and uploaded_by = auth.uid() and public.is_trip_member(trip_id));
create policy "docs: client removes own" on public.documents for delete to authenticated
  using (category = 'client' and uploaded_by = auth.uid());

-- update read receipts
create policy "reads: own" on public.update_reads for select to authenticated using (user_id = auth.uid() or public.is_advisor());
create policy "reads: mark own" on public.update_reads for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.updates u where u.id = update_id and public.is_trip_member(u.trip_id)));

-- checklist: clients read and tick
create policy "checklist: members read" on public.checklist_items for select to authenticated using (public.can_view_trip(trip_id));
create policy "checklist: members tick" on public.checklist_items for update to authenticated
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));
create policy "checklist: advisor manages" on public.checklist_items for all to authenticated using (public.is_advisor()) with check (public.is_advisor());

-- advisor tasks: advisor only
create policy "tasks: advisor only" on public.advisor_tasks for all to authenticated using (public.is_advisor()) with check (public.is_advisor());

-- ---------- grants (new tables are not exposed automatically) ----------
revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on function public.is_advisor(), public.is_trip_member(uuid), public.can_view_trip(uuid) to authenticated;

-- ---------- private file storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trip-files', 'trip-files', false, 20971520,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']);

-- files live at <trip_id>/<category>/<file>
create or replace function public.storage_trip_id(p text) returns uuid
language plpgsql immutable as $$
begin
  return ((storage.foldername(p))[1])::uuid;
exception when others then
  return null;
end; $$;

create policy "files: members read" on storage.objects for select to authenticated
  using (bucket_id = 'trip-files' and public.can_view_trip(public.storage_trip_id(name)));
create policy "files: advisor manages" on storage.objects for all to authenticated
  using (bucket_id = 'trip-files' and public.is_advisor())
  with check (bucket_id = 'trip-files' and public.is_advisor());
create policy "files: client uploads to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'trip-files' and (storage.foldername(name))[2] = 'client'
              and public.is_trip_member(public.storage_trip_id(name)));
create policy "files: client removes own uploads" on storage.objects for delete to authenticated
  using (bucket_id = 'trip-files' and (storage.foldername(name))[2] = 'client' and owner_id = auth.uid()::text);
