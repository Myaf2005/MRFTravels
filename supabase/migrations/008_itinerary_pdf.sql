-- 008: one document per trip can be "the itinerary PDF" that the portal's Download itinerary buttons hand out
alter table public.documents add column if not exists is_itinerary boolean not null default false;
create unique index if not exists documents_one_itinerary_per_trip on public.documents (trip_id) where is_itinerary;
update public.documents set is_itinerary = true
  where id = '41cc0006-4905-4d9b-be58-46ca68c179ca' and trip_id = '16163300-15b9-4584-8afc-f3d1d6d9f328';
select d.title, t.title as trip, d.is_itinerary from public.documents d join public.trips t on t.id = d.trip_id where d.is_itinerary;
