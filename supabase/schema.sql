-- Aperol Sprintz Mallorca – gemeinsame Ortsliste
-- Einmal im Supabase-Dashboard unter „SQL Editor“ ausführen.
--
-- Zugriffsprinzip: Jede Reise hat einen geheimen, zufälligen Schlüssel (steht im geteilten Link).
-- Die App schickt ihn bei jeder Anfrage als Header "x-trip-key". Die Row-Level-Security unten
-- erlaubt Lesen und Schreiben nur für Zeilen genau dieser Reise. Ohne Schlüssel sieht man nichts,
-- und fremde Reisen lassen sich weder auflisten noch erraten (160 Bit Zufall).

create table if not exists public.places (
  id          uuid primary key default gen_random_uuid(),
  trip_key    text not null check (char_length(trip_key) between 32 and 128),
  name        text not null check (char_length(name) <= 300),
  address     text not null default '' check (char_length(address) <= 500),
  lat         double precision check (lat between -90 and 90),
  lng         double precision check (lng between -180 and 180),
  url         text not null default '' check (char_length(url) <= 2000),
  note        text not null default '' check (char_length(note) <= 2000),
  list_name   text not null default '' check (char_length(list_name) <= 200),
  category    text not null default 'sonstiges' check (char_length(category) <= 80),
  added_by    text not null default '' check (char_length(added_by) <= 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists places_trip_key_idx on public.places (trip_key);

-- Routen (z. B. GPX-Rennradstrecken): eigene Tabelle statt lat/lng, weil eine Route aus
-- vielen aneinandergereihten Punkten besteht (points), nicht aus einem einzelnen Ort.
create table if not exists public.routes (
  id          uuid primary key default gen_random_uuid(),
  trip_key    text not null check (char_length(trip_key) between 32 and 128),
  name        text not null check (char_length(name) <= 300),
  category    text not null default 'rennrad-route' check (char_length(category) <= 80),
  points      jsonb not null default '[]'::jsonb,
  distance_km double precision,
  added_by    text not null default '' check (char_length(added_by) <= 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists routes_trip_key_idx on public.routes (trip_key);

create table if not exists public.trip_settings (
  trip_key           text primary key check (char_length(trip_key) between 32 and 128),
  airbnb             jsonb,
  custom_categories  jsonb not null default '[]'::jsonb,
  flights            jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now()
);

-- Für ein schon bestehendes Projekt (vor der Hin-/Rückreise-Box angelegt): Spalte nachrüsten.
alter table public.trip_settings add column if not exists flights jsonb not null default '{}'::jsonb;

-- Schlüssel aus dem Anfrage-Header lesen (leer → null → kein Zugriff)
create or replace function public.request_trip_key()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-trip-key', '')
$$;

alter table public.places enable row level security;
alter table public.routes enable row level security;
alter table public.trip_settings enable row level security;

drop policy if exists "Nur mit Reise-Schlüssel" on public.places;
create policy "Nur mit Reise-Schlüssel" on public.places
  for all to anon, authenticated
  using (trip_key = public.request_trip_key())
  with check (trip_key = public.request_trip_key());

drop policy if exists "Nur mit Reise-Schlüssel" on public.routes;
create policy "Nur mit Reise-Schlüssel" on public.routes
  for all to anon, authenticated
  using (trip_key = public.request_trip_key())
  with check (trip_key = public.request_trip_key());

drop policy if exists "Nur mit Reise-Schlüssel" on public.trip_settings;
create policy "Nur mit Reise-Schlüssel" on public.trip_settings
  for all to anon, authenticated
  using (trip_key = public.request_trip_key())
  with check (trip_key = public.request_trip_key());

grant select, insert, update, delete on public.places, public.routes, public.trip_settings to anon, authenticated;
