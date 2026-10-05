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
-- Nachträglich ergänzt: Markierung „glutenfrei“ pro Ort
alter table public.places add column if not exists gluten_free boolean not null default false;
-- Nachträglich ergänzt: Reservierung { date, time } pro Restaurant (null = nicht reserviert)
alter table public.places add column if not exists reservation jsonb;
-- Nachträglich ergänzt: Ort besucht (gilt für die ganze Reise); bewusst ohne „not null“
alter table public.places add column if not exists visited boolean default false;
-- Nachträglich ergänzt: Favorit (Stern), gilt für die ganze Reise; bewusst ohne „not null“
alter table public.places add column if not exists starred boolean default false;

-- Routen (z. B. GPX-Rennradstrecken): eigene Tabelle statt lat/lng, weil eine Route aus
-- vielen aneinandergereihten Punkten besteht (points), nicht aus einem einzelnen Ort.
create table if not exists public.routes (
  id          uuid primary key default gen_random_uuid(),
  trip_key    text not null check (char_length(trip_key) between 32 and 128),
  name        text not null check (char_length(name) <= 300),
  category    text not null default 'rennrad-route' check (char_length(category) <= 80),
  points      jsonb not null default '[]'::jsonb,
  distance_km double precision,
  elevation_gain_m double precision,
  elevation_loss_m double precision,
  url         text check (char_length(url) <= 2000),
  added_by    text not null default '' check (char_length(added_by) <= 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists routes_trip_key_idx on public.routes (trip_key);
-- Nachträglich ergänzt (Höhenmeter): bei bereits bestehender Tabelle die Spalten hinzufügen
alter table public.routes add column if not exists elevation_gain_m double precision;
alter table public.routes add column if not exists elevation_loss_m double precision;
-- Nachträglich ergänzt: Link zur Tour (Strava, Komoot …)
alter table public.routes add column if not exists url text check (char_length(url) <= 2000);

-- Original-GPX je Route (für den Download) – eigene Tabelle, damit der regelmäßige Abgleich die
-- großen Dateien nicht jedes Mal mitlädt. Wird beim Löschen der Route automatisch mit gelöscht.
create table if not exists public.route_files (
  route_id    uuid primary key references public.routes (id) on delete cascade,
  trip_key    text not null check (char_length(trip_key) between 32 and 128),
  gpx         text not null check (char_length(gpx) <= 5000000),
  created_at  timestamptz not null default now()
);

create table if not exists public.trip_settings (
  trip_key           text primary key check (char_length(trip_key) between 32 and 128),
  airbnb             jsonb,
  custom_categories  jsonb not null default '[]'::jsonb,
  flights            jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now()
);

-- Für ein schon bestehendes Projekt (vor der Hin-/Rückreise-Box angelegt): Spalte nachrüsten.
alter table public.trip_settings add column if not exists flights jsonb not null default '{}'::jsonb;

-- Reisekasse: Teilnehmende (Namen) pro Reise und erfasste Rechnungen
alter table public.trip_settings add column if not exists participants jsonb not null default '[]'::jsonb;

create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  trip_key      text not null check (char_length(trip_key) between 32 and 128),
  title         text not null default '' check (char_length(title) <= 200),
  amount_cents  integer not null check (amount_cents > 0 and amount_cents <= 100000000),
  paid_by       text not null check (char_length(paid_by) <= 80),
  shared_with   jsonb not null default '[]'::jsonb,
  spent_on      date,
  added_by      text not null default '' check (char_length(added_by) <= 80),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists expenses_trip_key_idx on public.expenses (trip_key);
-- Nachträglich ergänzt: Rückzahlung aus dem Ausgleich (kind = 'transfer'), in Franken erfasst
-- (orig = { currency, cents, rate }) und ungleiche Aufteilung (split = { mode, values }) – alle optional
alter table public.expenses add column if not exists kind text check (kind in ('transfer'));
alter table public.expenses add column if not exists orig jsonb;
alter table public.expenses add column if not exists split jsonb;

-- Schlüssel aus dem Anfrage-Header lesen (leer → null → kein Zugriff)
create or replace function public.request_trip_key()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-trip-key', '')
$$;

-- Zugangscode pro Reise (optional): Ist für eine Reise ein Code gesetzt, liefert die Datenbank nur noch
-- Daten, wenn die App zusätzlich zum Reise-Schlüssel den richtigen Code mitschickt (Header "x-trip-code").
-- Gespeichert wird nur eine bcrypt-Prüfsumme, nie der Code selbst. Ohne Code gilt wie bisher der Reise-Schlüssel.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.trip_access (
  trip_key    text primary key check (char_length(trip_key) between 32 and 128),
  code_hash   text not null,
  updated_at  timestamptz not null default now()
);
alter table public.trip_access enable row level security;
-- Keine Policies und keine Rechte: nur über die Funktionen unten erreichbar
revoke all on public.trip_access from anon, authenticated;

create or replace function public.request_trip_code()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-trip-code', '')
$$;

-- true, wenn für die Reise kein Code gesetzt ist oder der mitgeschickte Code stimmt.
-- Ein falscher Code verzögert die Antwort, damit sich Codes nicht schnell durchprobieren lassen.
create or replace function public.trip_code_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  stored text;
begin
  select code_hash into stored from public.trip_access where trip_key = public.request_trip_key();
  if stored is null then
    return true;
  end if;
  if extensions.crypt(coalesce(public.request_trip_code(), ''), stored) = stored then
    return true;
  end if;
  perform pg_sleep(0.5);
  return false;
end
$$;

-- Für die App: 'none' (kein Code gesetzt), 'ok' (Code stimmt) oder 'wrong' (Code fehlt/falsch)
create or replace function public.trip_code_status()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if public.request_trip_key() is null
     or not exists (select 1 from public.trip_access where trip_key = public.request_trip_key()) then
    return 'none';
  end if;
  return case when public.trip_code_ok() then 'ok' else 'wrong' end;
end
$$;

-- Code setzen, ändern (alter Code nötig) oder mit leerem Text entfernen
create or replace function public.set_trip_code(new_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k text := public.request_trip_key();
begin
  if k is null or char_length(k) < 32 then
    raise exception 'kein gültiger Reise-Schlüssel';
  end if;
  if not public.trip_code_ok() then
    raise exception 'der bisherige Zugangscode stimmt nicht';
  end if;
  if coalesce(new_code, '') = '' then
    delete from public.trip_access where trip_key = k;
    return true;
  end if;
  if char_length(new_code) < 6 or char_length(new_code) > 64 then
    raise exception 'der Code muss 6 bis 64 Zeichen lang sein';
  end if;
  insert into public.trip_access (trip_key, code_hash, updated_at)
  values (k, extensions.crypt(new_code, extensions.gen_salt('bf', 8)), now())
  on conflict (trip_key) do update set code_hash = excluded.code_hash, updated_at = now();
  return true;
end
$$;

grant execute on function public.trip_code_status(), public.set_trip_code(text) to anon, authenticated;

alter table public.places enable row level security;
alter table public.routes enable row level security;
alter table public.route_files enable row level security;
alter table public.trip_settings enable row level security;
alter table public.expenses enable row level security;

-- Zugriff nur mit Reise-Schlüssel – und, falls für die Reise gesetzt, mit dem richtigen Zugangscode
drop policy if exists "Nur mit Reise-Schlüssel" on public.places;
create policy "Nur mit Reise-Schlüssel" on public.places
  for all to anon, authenticated
  using (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()))
  with check (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()));

drop policy if exists "Nur mit Reise-Schlüssel" on public.routes;
create policy "Nur mit Reise-Schlüssel" on public.routes
  for all to anon, authenticated
  using (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()))
  with check (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()));

drop policy if exists "Nur mit Reise-Schlüssel" on public.route_files;
create policy "Nur mit Reise-Schlüssel" on public.route_files
  for all to anon, authenticated
  using (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()))
  with check (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()));

drop policy if exists "Nur mit Reise-Schlüssel" on public.trip_settings;
create policy "Nur mit Reise-Schlüssel" on public.trip_settings
  for all to anon, authenticated
  using (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()))
  with check (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()));

drop policy if exists "Nur mit Reise-Schlüssel" on public.expenses;
create policy "Nur mit Reise-Schlüssel" on public.expenses
  for all to anon, authenticated
  using (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()))
  with check (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()));

grant select, insert, update, delete on public.places, public.routes, public.route_files, public.trip_settings, public.expenses to anon, authenticated;

-- Supabase die neuen Funktionen und Tabellen sofort bekannt machen (sonst ggf. erst nach einigen Minuten)
notify pgrst, 'reload schema';
