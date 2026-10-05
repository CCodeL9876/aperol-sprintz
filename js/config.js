// Zugangsdaten für die gemeinsame Ortsliste (Supabase).
// Beide Werte stehen in Supabase unter „Project Settings → API“ bzw. „Connect“.
// Der „anon“/„publishable“ Key ist für den Browser gedacht und darf öffentlich sein –
// geschützt werden die Daten durch den geheimen Reise-Link (siehe supabase/schema.sql).
// Solange die Felder leer sind, speichert die App nur lokal im Browser.

export const SUPABASE_URL = 'https://cdyqbsurhvauheonfaqh.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_G925wSaWBj-DIK_xWYjQOw_PCCPwZQy';

// Fest hinterlegte Unterkunft: NUR für ein privates Repository sinnvoll. Diese Datei wird mit dem
// Quellcode auf GitHub veröffentlicht – ein hier eingetragener Wert ist für jeden einsehbar, der das
// Repository (auch über die Versionsgeschichte) findet, unabhängig vom geheimen Reise-Schlüssel.
//
// Bei einem öffentlichen Repository (wie hier) auf `null` lassen. Die Unterkunft wird dann in der App
// selbst gesetzt (Suche oder Klick auf die Karte, Box „Unterkunft“) und landet in der Datenbank – dort
// sichtbar nur mit dem geheimen Reise-Schlüssel, nicht im Quellcode. Über „Links hinzufügen“ lassen sich
// dort zusätzlich der Airbnb- und der Google-Maps-Link nachtragen.
export const FIXED_AIRBNB = null;

// Google Maps ist die Standardkarte; OpenStreetMap gibt es über den Schalter „Google | OSM“ auf der Karte
// oder mit ?karte=osm in der Adresse. Der Schlüssel ist – wie der Supabase-Key –
// für den Browser gedacht und öffentlich sichtbar. Deshalb in der Google Cloud Console UNBEDINGT auf die
// eigenen Website-Adressen einschränken (siehe ANLEITUNG.md, Abschnitt „Google Maps“).
// Leer lassen = nur OpenStreetMap.
export const GOOGLE_MAPS_API_KEY = 'AIzaSyDUaIdiA9_jRel67xyEPqdaQBqEY-ZQWmM';
// Optional: eigene Map-ID aus der Google Cloud Console (für eigene Kartenstile). Leer = Googles Test-ID.
export const GOOGLE_MAPS_MAP_ID = 'AIzaSyDUaIdiA9_jRel67xyEPqdaQBqEY-ZQWmM';
