# Aperol Sprintz – Unsere Orte auf Mallorca

Web-App, die gespeicherte Google-Maps-Orte auf einer Karte und in einer Liste zeigt – filterbar nach Art des Orts
(Kaffee, Restaurant, Rennrad-Hotspot, …), sortierbar nach Entfernung zum Airbnb.
Design „Aperol Spritz“ – wie ein handgemaltes Poster: Papierweiß, Aperol-Orange und Flaschengrün, Überschriften in
Permanent Marker, gemalte Pinselkanten (SVG-Filter) um Karte, Knöpfe und Karten; Text in Instrument Sans.

Reines HTML/CSS/JS (ES-Module), kein Build-Schritt, keine Installation.
Karte: [Leaflet](https://leafletjs.com) mit OpenStreetMap-Kacheln (per CSS-Filter zurückgenommen); Adresssuche über OpenStreetMap (Nominatim, bei Fehlern automatisch Photon) – kein API-Key nötig.

## Starten

ES-Module laden nicht über `file://`, daher einen lokalen Server starten:

```sh
cd mallorca-places
python3 serve.py
```

`serve.py` ist ein kleiner Server ohne Browser-Cache – so lädt Safari nie alte Dateien.
(`python3 -m http.server 5173` geht auch, dann nach Änderungen in Safari mit **Cmd+Option+R** neu laden.)

Dann <http://localhost:5173> öffnen. (Mit Node geht auch `npm start`.)
Zum Ausprobieren im Import-Dialog auf **„Beispielorte laden“** klicken.

## Funktionen

- **Import** per Drag & Drop: Takeout-`Gespeicherte Orte.json`, Listen-CSVs, KML aus My Maps, eigene CSVs
  (Spalten `name`, `lat`, `lng`, `category` …), Llocs-Backups – oder Google-Maps-Links einfügen.
- **GPX-Rennradrouten** (Strava, Komoot, Garmin, RideWithGPS …) per Drag & Drop importieren. Werden als eigene
  Art „Rennrad-Route“ gespeichert und stehen in der Seitenleiste im Abschnitt „Rennrad-Routen“ unter den Orten –
  mit Länge und Höhenmetern (aus den `<ele>`-Werten der GPX, GPS-Rauschen unter 4 m wird ignoriert).
  Standardmäßig ausgeblendet; der Schalter pro Route zeichnet die Strecke (Linie, keine Punkte) auf der Karte ein.
  Jede Route lässt sich wieder **als GPX herunterladen** (z. B. für Garmin/Wahoo): in voller Auflösung mit Höhen,
  sofern beim Import gespeichert (Tabelle `route_files`); bei älteren Importen aus den Kartenpunkten erzeugt.
  **Start und Ziel beim Airbnb** (Checkbox im Import-Fenster, Standard an, `js/home-loop.js`): Rundtouren, die bis
  1 km am Airbnb vorbeiführen, beginnen dort; sonst werden Anfahrt und Rückfahrt mit dem Rennrad-Routenplaner
  [BRouter](https://brouter.de) (Profil `fastbike`, ohne Schlüssel) ergänzt – Länge, Höhenmeter und GPX-Datei gelten
  dann für die ganze Runde. Ist BRouter nicht erreichbar, wird die Etappe unverändert übernommen.
  Pro Route lässt sich zudem ein **Link** (Strava, Komoot …) hinterlegen – erscheint unter der Route und im Karten-Popup.
  **Kaffee-Stopps** (eigene Kaffees und Rennrad-Hotspots bis 500 m neben der Strecke) mit Kilometer, geschätzter
  Ankunftszeit ab der gewählten Startzeit und ob der Ort dann geöffnet ist; der Stopp um die Streckenmitte ist als
  Halbzeit markiert. **Trinkbrunnen und Velo-Werkstätten** entlang der Strecke kommen aus OpenStreetMap
  (Overpass-API, `js/pois.js`), werden beim Import einmal geladen und bei der Etappe gespeichert (Spalte
  `routes.pois`, für alle); sie erscheinen in den Details und als kleine Punkte auf der Karte.
- **Automatische Kategorie** über Stichwörter im Namen bzw. über den Listennamen (`Rennrad.csv` → Rennrad-Hotspot).
  Google exportiert keine Orts-Typen, daher lässt sich die Kategorie pro Ort in der Liste ändern.
- **Fehlende Standorte** (typisch bei Listen-CSVs) werden über OpenStreetMap gesucht (1 Anfrage/Sekunde).
- **Airbnb** per Adresse, Maps-Link, Koordinaten oder Klick auf die Karte setzen; optional „Links
  hinzufügen“ für das Airbnb-Inserat und einen Google-Maps-Link. Wird in der Datenbank gespeichert,
  nie im Quellcode (siehe `js/config.js`).
- **Hin- & Rückreise**: Datum und Uhrzeit von Hin- und Rückflug eintragen (Box über der Unterkunft),
  wird wie die Unterkunft gespeichert und in einer gemeinsamen Reise mit allen geteilt.
- **Filter**: Kategorie-Chips (Mehrfachauswahl), „Jetzt offen“, Volltextsuche, Sortierung nach Entfernung/Name/Art/Datum.
- **Öffnungszeiten** von Google Places (Spalte `places.hours`, `js/hours.js`): beim Hinzufügen aus der Google-Karte
  automatisch, für bestehende Orte über Menü `•••` → „Öffnungszeiten laden“. Liste und Karten-Popup zeigen
  „Offen bis …“ bzw. „Geschlossen · öffnet …“.
- **Ausgaben**: Rechnung direkt bei einem Ort erfassen („Rechnung“ in der Liste bzw. im Karten-Popup).
- **Fotos**: Menü `•••` → „Fotos · Geteiltes Album“ öffnet auf iPhone/iPad die Fotos-App (dort „Geteilte Alben“).
  Apple zeigt nur Alben, zu denen man eingeladen ist – die App selbst speichert keinen Album-Link.
- **Ohne Netz**: `sw.js` hält App-Dateien und gesehene OpenStreetMap-Kacheln vor; der zuletzt geladene Stand
  der gemeinsamen Reise liegt im Cache Storage. Ohne Verbindung zeigt die App diesen Stand (nur lesen) und
  verbindet sich neu, sobald Netz da ist.
- **Eigene Kategorien** mit Emoji, Farbe und Stichwörtern (Standard-Kategorien nutzen Linien-Symbole) (Menü `•••` → „Kategorien verwalten“).
- **Gemeinsame Reise**: Über „Teilen“ werden die Orte in eine Supabase-Datenbank hochgeladen; alle mit dem
  geheimen Reise-Link sehen dieselbe Liste und können mitplanen (Abgleich alle 20 s). Einrichtung: [ANLEITUNG.md](ANLEITUNG.md).
- Ohne gemeinsame Reise bleiben die Daten lokal im Browser (`localStorage`); Backup als JSON über das Menü.

## Projektstruktur

```
mallorca-places/
├── index.html               Grundgerüst: Kopfzeile, Seitenleiste, Karte, Dialoge
├── ANLEITUNG.md             Online stellen (GitHub Pages) + gemeinsame Datenbank (Supabase)
├── manifest.webmanifest     „Zum Home-Bildschirm“ auf dem iPhone
├── css/styles.css           Design „Aperol Spritz“, responsive (Karte randlos; Desktop: Seitenleiste schwebt links darüber; Handy: Liste als ziehbares Blatt von unten)
├── js/
│   ├── app.js               Zustand, Filter, Rendering, Import-Ablauf, Dialoge, Teilen
│   ├── backend.js           Speicher: lokal im Browser oder gemeinsame Reise in Supabase
│   ├── config.js            Supabase-URL und öffentlicher Key (leer = nur lokal); Unterkunft NICHT hier eintragen (öffentlich auf GitHub)
│   ├── categories.js        Standard-Kategorien + Stichwort-Erkennung
│   ├── icons.js             Linien-Symbole für Kategorien und Bedienelemente
│   ├── importers.js         Parser für GeoJSON, CSV, KML, GPX, Links; Kategorie-Zuordnung
│   ├── geo.js               Distanz, Koordinaten aus Maps-Links, Geocoding
│   ├── map.js               Leaflet-Karte, Marker, Airbnb-Marker, Routen-Linien
│   ├── map-google.js        Test-Variante mit Google Maps (Google-Orte antippen & übernehmen), siehe ANLEITUNG.md
│   └── store.js             localStorage, Backup-Download, IDs und Reise-Schlüssel
├── data/sample-places.json  21 Beispielorte im Google-Takeout-Format
├── serve.py                 lokaler Testserver ohne Browser-Cache
├── deploy.sh                ein Befehl: Version erhöhen, committen, zu GitHub hochladen
├── vendor/leaflet/          Kartenbibliothek Leaflet 1.9.4 (lokal, kein CDN nötig)
├── supabase/schema.sql      Tabellen + Zugriffsregeln (nur mit Reise-Schlüssel)
└── assets/                  Favicon und App-Symbole
```

## Orte aus Google Maps exportieren

1. <https://takeout.google.com> öffnen, „Alle abwählen“.
2. **„Maps (Meine Orte)“** (→ `Gespeicherte Orte.json`) und **„Gespeichert“** (→ eine CSV pro Liste) auswählen.
3. Export herunterladen, entpacken und die Dateien in der App importieren.

Hinweise:
- Kurzlinks (`maps.app.goo.gl/…`) enthalten keine Koordinaten – einmal im Browser öffnen und den langen Link kopieren.
- KMZ-Dateien aus My Maps vorher entpacken (enthalten eine `doc.kml`) oder in My Maps „Als KML exportieren“ wählen.

## Mögliche nächste Schritte

- Mehrere Unterkünfte (z. B. für verschiedene Reisen) speichern und umschalten
- Höhenprofil pro Route
- Marker-Clustering bei sehr vielen Orten
