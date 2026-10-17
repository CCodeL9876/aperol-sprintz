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
-- Öffnungszeiten von Google (js/hours.js): { p: [[Tag, Minute, Tag, Minute], …], w: [Texte], at: 'JJJJ-MM-TT' }
alter table public.places add column if not exists hours jsonb;

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
-- Nachträglich ergänzt: Route gefahren (für die ganze Reise) und Link zur gefahrenen Aktivität (Strava …)
alter table public.routes add column if not exists ridden boolean default false;
alter table public.routes add column if not exists activity_url text check (char_length(activity_url) <= 2000);
-- Trinkwasser und Velo-Werkstätten entlang der Etappe (aus OpenStreetMap, js/pois.js) – einmal geladen, für alle
alter table public.routes add column if not exists pois jsonb;
-- Nachträglich ergänzt: Sterne je Person, 1–5. Schlüssel ist die Personen-ID aus trip_settings.participants:
-- { "<person-id>": 4, "<andere-person-id>": 5 }. Bewusst ohne „not null“ – bei einem Sammel-Insert füllt
-- Supabase fehlende Felder einzelner Zeilen mit null statt mit dem Standardwert (siehe gluten_free in js/backend.js);
-- null gilt in der App als „noch nicht bewertet“.
alter table public.routes add column if not exists ratings jsonb;
-- Effektive Fahrzeit je Person in Minuten (ohne Pausen): { "<person-id>": 165 } – daraus rechnet die App das
-- persönliche Tempo (Ebene und Höhenmeter) für die Fahrzeiten. Wie ratings bewusst ohne „not null“.
alter table public.routes add column if not exists ride_times jsonb;

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

-- Zugangscode pro Reise – Pflicht: Erreichbar sind nur Reisen, die in trip_access eingetragen sind, und nur mit
-- dem richtigen Code (Header "x-trip-code") zusätzlich zum Reise-Schlüssel. Neue Reisen lassen sich über die App
-- nicht anlegen; Codes nur ändern, nicht entfernen. Gespeichert wird nur eine bcrypt-Prüfsumme, nie der Code.
-- ACHTUNG: nur im Mallorca-Projekt ausführen – Reisen ohne Eintrag in trip_access sind danach gesperrt.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.trip_access (
  trip_key    text primary key check (char_length(trip_key) between 32 and 128),
  code_hash   text not null,
  updated_at  timestamptz not null default now()
);
alter table public.trip_access enable row level security;
-- Keine Policies und keine Rechte: nur über die Funktionen unten erreichbar
revoke all on public.trip_access from anon, authenticated;
-- Admin-PIN (bcrypt-Prüfsumme), siehe „Admin“ weiter unten; leer = noch kein Admin festgelegt
alter table public.trip_access add column if not exists admin_hash text;

create or replace function public.request_trip_code()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-trip-code', '')
$$;

-- true nur, wenn die Reise eingetragen ist und der mitgeschickte Code stimmt (unbekannte Reise → false).
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
    return false;
  end if;
  if extensions.crypt(coalesce(public.request_trip_code(), ''), stored) = stored then
    return true;
  end if;
  perform pg_sleep(0.5);
  return false;
end
$$;

-- Für die App: 'unknown' (keine eingetragene Reise), 'ok' (Code stimmt) oder 'wrong' (Code fehlt/falsch)
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
    return 'unknown';
  end if;
  return case when public.trip_code_ok() then 'ok' else 'wrong' end;
end
$$;

-- Code einer eingetragenen Reise ändern (alter Code nötig, und – sobald es einen Admin gibt – die Admin-PIN).
-- Neue Reisen anlegen oder Codes entfernen geht nicht – eine neue Reise trägt man bei Bedarf hier im SQL Editor ein
-- (siehe ANLEITUNG.md, Abschnitt 2c). Die frühere Fassung ohne Admin-PIN wird entfernt, damit sie nicht als
-- Hintertür bestehen bleibt.
drop function if exists public.set_trip_code(text);
create or replace function public.set_trip_code(new_code text, admin_pin text default null)
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
  if not exists (select 1 from public.trip_access where trip_key = k) then
    raise exception 'diese Reise ist nicht eingetragen';
  end if;
  if not public.trip_code_ok() then
    raise exception 'der bisherige Zugangscode stimmt nicht';
  end if;
  if (select admin_hash from public.trip_access where trip_key = k) is not null
     and not public.trip_admin_ok(admin_pin) then
    raise exception 'nur der Admin kann den Zugangscode ändern';
  end if;
  if coalesce(new_code, '') = '' then
    raise exception 'der Zugangscode kann nur geändert, nicht entfernt werden';
  end if;
  if char_length(new_code) < 6 or char_length(new_code) > 64 then
    raise exception 'der Code muss 6 bis 64 Zeichen lang sein';
  end if;
  -- Nur einfache Zeichen: Der Code geht als HTTP-Header mit, und Browser senden z. B. Umlaute nicht als UTF-8
  if new_code !~ '^[ -~]+$' then
    raise exception 'bitte nur Buchstaben ohne Umlaute, Ziffern und einfache Satzzeichen';
  end if;
  update public.trip_access
     set code_hash = extensions.crypt(new_code, extensions.gen_salt('bf', 8)), updated_at = now()
   where trip_key = k;
  return true;
end
$$;

-- --- Admin -----------------------------------------------------------------------------------------
-- Wer die Admin-PIN kennt (zusätzlich zum Zugangscode), ist Admin: Nur er kann den Zugangscode ändern und alle
-- Orte auf einmal löschen. Die PIN geht als Parameter mit; gespeichert wird nur eine bcrypt-Prüfsumme.
-- Solange keine PIN festgelegt ist, gilt das bisherige Verhalten – wer sie zuerst festlegt, ist Admin.

-- true nur mit gültigem Zugangscode, festgelegter Admin-PIN und passender PIN (falsche PIN verzögert die Antwort)
-- Hinweis: Die Funktion wird oben in set_trip_code verwendet – plpgsql prüft das erst beim Aufruf.
create or replace function public.trip_admin_ok(pin text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  stored text;
begin
  if not public.trip_code_ok() then
    return false;
  end if;
  select admin_hash into stored from public.trip_access where trip_key = public.request_trip_key();
  if stored is null or coalesce(pin, '') = '' then
    return false;
  end if;
  if extensions.crypt(pin, stored) = stored then
    return true;
  end if;
  perform pg_sleep(0.5);
  return false;
end
$$;

-- Für die App: 'none' (noch kein Admin), 'ok' (PIN stimmt) oder 'locked' (PIN festgelegt, fehlt oder falsch)
create or replace function public.trip_admin_status(pin text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.trip_code_ok() then
    raise exception 'kein Zugriff auf diese Reise';
  end if;
  if (select admin_hash from public.trip_access where trip_key = public.request_trip_key()) is null then
    return 'none';
  end if;
  return case when public.trip_admin_ok(pin) then 'ok' else 'locked' end;
end
$$;

-- Admin-PIN festlegen (gibt es noch keine) oder ändern (dann ist die bisherige PIN nötig)
create or replace function public.set_admin_pin(new_pin text, old_pin text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.trip_code_ok() then
    raise exception 'kein Zugriff auf diese Reise';
  end if;
  if (select admin_hash from public.trip_access where trip_key = public.request_trip_key()) is not null
     and not public.trip_admin_ok(old_pin) then
    raise exception 'die bisherige Admin-PIN stimmt nicht';
  end if;
  if char_length(coalesce(new_pin, '')) < 4 or char_length(new_pin) > 64 then
    raise exception 'die Admin-PIN muss 4 bis 64 Zeichen lang sein';
  end if;
  update public.trip_access
     set admin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf', 8)), updated_at = now()
   where trip_key = public.request_trip_key();
  return true;
end
$$;

-- Alle Orte der Reise auf einmal löschen – nur mit Admin-PIN. Rückgabe: Anzahl gelöschter Orte.
create or replace function public.delete_all_places(admin_pin text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if not public.trip_admin_ok(admin_pin) then
    raise exception 'nur der Admin kann alle Orte löschen';
  end if;
  delete from public.places where trip_key = public.request_trip_key();
  get diagnostics n = row_count;
  return n;
end
$$;

grant execute on function public.trip_code_status(), public.set_trip_code(text, text),
  public.trip_admin_status(text), public.set_admin_pin(text, text), public.delete_all_places(text)
  to anon, authenticated;
-- trip_admin_ok nur intern (sonst ließen sich PINs direkt durchprobieren – mit Verzögerung, aber unnötig offen)
revoke execute on function public.trip_admin_ok(text) from public, anon, authenticated;

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

-- Google-Verbrauch (Admin → „Google-Verbrauch“): Die App zählt ihre Google-Abfragen je Preisstufe und Monat.
-- Für den ganzen API-Schlüssel gemeinsam (nicht je Reise). Kein direkter Tabellenzugriff: Hochzählen nur mit
-- gültigem Reise-Schlüssel und Zugangscode, Lesen nur mit Admin-PIN.
create table if not exists public.google_usage (
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  sku   text not null check (sku ~ '^[A-Za-z]{2,30}$'),
  n     bigint not null default 0,
  primary key (month, sku)
);
alter table public.google_usage enable row level security;
revoke all on public.google_usage from anon, authenticated;

-- counts: { "sku": Anzahl, … } – höchstens 20 Einträge, je höchstens 1000 pro Aufruf
create or replace function public.bump_google_usage(counts jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m text := to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM');
  k text;
  v jsonb;
begin
  if not public.trip_code_ok() then
    raise exception 'kein Zugriff auf diese Reise';
  end if;
  if jsonb_typeof(counts) <> 'object' or (select count(*) from jsonb_object_keys(counts)) > 20 then
    raise exception 'ungültige Zähler';
  end if;
  for k, v in select * from jsonb_each(counts) loop
    if k !~ '^[A-Za-z]{2,30}$' or jsonb_typeof(v) <> 'number' or (v::text)::numeric not between 1 and 1000
       or (v::text)::numeric <> trunc((v::text)::numeric) then
      continue;
    end if;
    insert into public.google_usage (month, sku, n) values (m, k, (v::text)::bigint)
      on conflict (month, sku) do update set n = public.google_usage.n + excluded.n;
  end loop;
end
$$;

-- Die letzten drei Monate lesen – nur mit Admin-PIN
create or replace function public.google_usage_overview(pin text)
returns table (month text, sku text, n bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.trip_admin_ok(pin) then
    raise exception 'nur der Admin sieht den Google-Verbrauch';
  end if;
  return query
    select u.month, u.sku, u.n from public.google_usage u
     where u.month >= to_char((now() at time zone 'America/Los_Angeles') - interval '2 months', 'YYYY-MM')
     order by u.month, u.sku;
end
$$;

grant execute on function public.bump_google_usage(jsonb), public.google_usage_overview(text) to anon, authenticated;

-- Live-Standort (Menü „Live-Standort teilen“): Wer es einschaltet, ist für die anderen der Reise bis zum gewählten
-- Ende auf der Karte zu sehen. Gespeichert wird nur die letzte Position je Person (kein Verlauf); „Beenden“ löscht
-- sie, abgelaufene Einträge räumt der Trigger beim nächsten Schreiben weg. Zeiten setzt die Datenbank selbst,
-- höchstens 12 Stunden im Voraus.
create table if not exists public.live_positions (
  trip_key    text not null check (char_length(trip_key) between 32 and 128),
  person_id   text not null check (char_length(person_id) between 1 and 64),
  name        text not null default '' check (char_length(name) <= 80),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  accuracy    real check (accuracy is null or accuracy between 0 and 100000),
  speed       real check (speed is null or speed between 0 and 200),
  route_id    text check (route_id is null or char_length(route_id) <= 64),
  updated_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (trip_key, person_id)
);

create or replace function public.live_positions_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.expires_at := least(greatest(new.expires_at, now()), now() + interval '12 hours');
  delete from public.live_positions where trip_key = new.trip_key and person_id <> new.person_id and expires_at < now();
  return new;
end
$$;
drop trigger if exists live_positions_stamp on public.live_positions;
create trigger live_positions_stamp before insert or update on public.live_positions
  for each row execute function public.live_positions_stamp();

alter table public.live_positions enable row level security;
drop policy if exists "Nur mit Reise-Schlüssel" on public.live_positions;
create policy "Nur mit Reise-Schlüssel" on public.live_positions
  for all to anon, authenticated
  using (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()))
  with check (trip_key = (select public.request_trip_key()) and (select public.trip_code_ok()));
grant select, insert, update, delete on public.live_positions to anon, authenticated;

-- Supabase die neuen Funktionen und Tabellen sofort bekannt machen (sonst ggf. erst nach einigen Minuten)
notify pgrst, 'reload schema';
