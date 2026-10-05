# Aperol Sprintz online stellen und gemeinsam nutzen

Dauer: etwa 20 Minuten. Du brauchst ein kostenloses Konto bei **Supabase** (Datenbank für die gemeinsame
Ortsliste) und bei **GitHub** (hostet die App als Website). Danach funktioniert die App auf jedem Gerät,
auch unterwegs, und alle mit dem Reise-Link sehen dieselben Orte und können welche hinzufügen.

> **Wo liegen die Orte?**
> - **Ohne Supabase** speichert jeder Browser seine eigene Liste (localStorage) – getrennt nach Gerät,
>   Browser und Adresse. `localhost:5173` und die spätere Online-Adresse sind zwei verschiedene Listen.
> - **Mit Supabase und gemeinsamer Reise** liegen die Orte in der Datenbank. Alle Geräte und alle
>   Mitreisenden sehen dieselbe Liste; der Browser merkt sich nur noch den Reise-Link.

---

## 1. Deine bisherigen Orte sichern

Solange die Orte nur im Browser liegen, nimmst du sie so mit:

1. Die App wie gewohnt lokal öffnen (`python3 serve.py`, dann <http://localhost:5173>) – in dem Browser,
   in dem deine Orte gespeichert sind.
2. Menü **•••** → **Backup herunterladen**. Es entsteht eine Datei `aperol-sprintz-backup-….json`.

Die Datei importierst du in Schritt 4 auf der Online-Seite.

---

## 2. Datenbank bei Supabase anlegen

1. Auf <https://supabase.com> registrieren (am einfachsten „Continue with GitHub“, siehe Schritt 3).
2. **New project** anlegen:
   - Name: `aperol-sprintz`
   - Database Password: ein beliebiges sicheres Passwort (brauchst du für die App nicht)
   - Region: **Central EU (Frankfurt)**
3. Warten, bis das Projekt bereit ist (ca. 1–2 Minuten).
4. Links im Menü **SQL Editor** öffnen → **New query**.
5. Den kompletten Inhalt der Datei `supabase/schema.sql` hineinkopieren und auf **Run** klicken.
   Unten sollte „Success. No rows returned“ stehen.
6. Oben auf **Connect** klicken (oder *Project Settings → API Keys*) und zwei Werte kopieren:
   - die **Project URL**, z. B. `https://abcdefgh.supabase.co`
   - den **anon public** Key (oder den **publishable** Key, beginnt mit `sb_publishable_`)
7. Die Datei `js/config.js` öffnen und beide Werte eintragen:

   ```js
   export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi…';
   ```

   Dieser Key ist für den Browser gedacht und darf öffentlich sein. Die Orte sind trotzdem geschützt:
   Die Datenbank gibt nur Orte heraus, wenn der geheime Reise-Schlüssel aus dem Link mitgeschickt wird.

   Die Unterkunft „Unser Airbnb“ gehört bewusst **nicht** hierher: `js/config.js` landet mit dem
   Quellcode auf GitHub und wäre damit für alle einsehbar. Sie wird stattdessen einmal in der App
   selbst gesetzt (Box „Unterkunft“ → Adresse suchen oder auf der Karte wählen) und landet dann in der
   Datenbank – geschützt durch den geheimen Reise-Schlüssel wie die Orte auch. Über „Links hinzufügen“
   lassen sich dort optional noch der Airbnb- und der Google-Maps-Link nachtragen.

> **Gut zu wissen:** Kostenlose Supabase-Projekte werden nach etwa einer Woche ohne Nutzung pausiert.
> Die Daten bleiben erhalten; im Supabase-Dashboard auf **Restore project** klicken, dann läuft alles wieder.

---

## 2a. Datenbank aktualisieren (nach neuen Funktionen)

Ausgaben, Reservierungen, „besucht“ und Favoriten brauchen zusätzliche Spalten und die Tabelle `expenses`.
Dafür im Supabase-Dashboard → **SQL Editor** → **New query** den kompletten Inhalt von `supabase/schema.sql`
einfügen und auf **Run** klicken. Das Skript ergänzt nur, was fehlt (`if not exists`) – bestehende Orte,
Routen und Einstellungen bleiben unverändert. Es darf beliebig oft ausgeführt werden.

Solange das nicht passiert ist, läuft die App trotzdem; im Fenster „Ausgaben“ erscheint dann ein Hinweis.

## 2b. Google-Maps-Kurzlinks direkt einfügen (einmalig einrichten)

Teilt man einen Ort in der Google-Maps-App (**Teilen → Kopieren**), entsteht ein Kurzlink wie
`https://maps.app.goo.gl/…`. Darin stehen weder Name noch Koordinaten – die kennt erst die lange
Google-Adresse, auf die der Kurzlink weiterleitet. Der Browser darf diese Weiterleitung nicht selbst lesen,
deshalb übernimmt das eine kleine Funktion in deinem Supabase-Projekt. Sie nimmt nur Google-Maps-Kurzlinks
an, gibt nur die lange Google-Maps-Adresse zurück und speichert nichts.

1. Im Supabase-Dashboard dein Projekt öffnen → links **Edge Functions**.
2. **Deploy a new function** → **Via Editor**.
3. Als Namen genau `resolve-maps-link` eintragen.
4. Den Beispielcode im Editor komplett löschen und den Inhalt der Datei
   `supabase/functions/resolve-maps-link/index.ts` hineinkopieren → **Deploy function**.
5. In der Funktion die **Einstellungen/Details** öffnen und die JWT-Prüfung ausschalten
   (Schalter „Verify JWT“ bzw. „Enforce JWT verification“) → speichern.
   Grund: Die App meldet sich nicht mit einem Benutzerkonto an, sondern nutzt nur den öffentlichen Schlüssel.
6. Fertig. In der App bei **Importieren → Links einfügen** den kopierten Kurzlink einfügen – der Ort erscheint
   mit Name und genauer Position. Auch mehrere Links (einer pro Zeile) und der komplette geteilte Text
   (Name, Adresse, Link) funktionieren. Im Feld „Google-Maps-Link“ der Unterkunft geht es genauso.

Ist die Funktion (noch) nicht eingerichtet, sucht die App solche Orte über den Namen und weist im Import darauf hin.

## 2c. Zugangscode – nur eure Reise und eine Demo

Erreichbar sind nur Reisen, die in der Tabelle `trip_access` eingetragen sind, und nur mit Reise-Link **und**
Zugangscode. Alles andere zeigt die Demo-Ansicht mit Beispieldaten (nichts wird gespeichert). Über die App lassen
sich keine neuen Reisen anlegen und Codes nur ändern, nicht entfernen. Gespeichert wird nur eine bcrypt-Prüfsumme.

- **Eure Reise:** `https://ccodel9876.github.io/aperol-sprintz/#reise=…` + Code
- **Demo-Link:** `https://ccodel9876.github.io/aperol-sprintz/#demo` (zeigt immer die Demo)

Einrichten bzw. aktualisieren:
1. **Vorher prüfen:** In der App unter **Teilen** muss „Mit Zugangscode geschützt“ stehen. Sonst zuerst dort den
   Code festlegen – nach Schritt 2 wäre die Reise ohne Code gesperrt.
2. Den kompletten Inhalt von `supabase/schema.sql` **im Mallorca-Projekt** im SQL Editor ausführen.
   (Nicht in Milano: dort gibt es keinen eingetragenen Code, die Reise wäre danach gesperrt.)
3. Die aktuelle App hochladen (`./deploy.sh`) und auf allen Handys einmal neu laden.

Code ändern: in der App **Teilen → Zugangscode ändern**. Danach fragt die App bei allen anderen den neuen Code ab.

Reise ohne Code nachträglich eintragen oder eine neue Reise anlegen (im SQL Editor, Werte ersetzen):
```sql
-- neuen Reise-Schlüssel erzeugen (nur für eine neue Reise):
select encode(extensions.gen_random_bytes(20), 'hex');
-- Reise mit Code eintragen:
insert into public.trip_access (trip_key, code_hash)
values ('REISE-SCHLÜSSEL', extensions.crypt('CODE', extensions.gen_salt('bf', 8)));
```
Code vergessen: Mitreisende fragen – oder die Zeile in `trip_access` wie oben mit neuem Code ersetzen
(`update public.trip_access set code_hash = extensions.crypt('NEUER-CODE', extensions.gen_salt('bf', 8)) where trip_key = '…';`).

## 3. App auf GitHub Pages veröffentlichen

### Variante A: im Browser (ohne Terminal)

1. Auf <https://github.com> anmelden und unter <https://github.com/new> ein Repository anlegen:
   - Name: `aperol-sprintz`
   - Sichtbarkeit: **Public** (GitHub Pages ist für private Repositories kostenpflichtig)
   - „Create repository“
2. Auf der leeren Repository-Seite **uploading an existing file** anklicken.
3. Im Finder den **Inhalt** des Ordners `mallorca-places` markieren (alle Dateien und Ordner, nicht den
   Ordner selbst) und ins Browserfenster ziehen. Wichtig sind vor allem `index.html`, `manifest.webmanifest`
   und die Ordner `css`, `js`, `vendor`, `assets`, `data`. Mit **Commit changes** bestätigen.
4. Im Repository **Settings → Pages** öffnen:
   - Source: **Deploy from a branch**
   - Branch: **main**, Ordner **/ (root)** → **Save**
5. Nach 1–2 Minuten steht oben die Adresse, z. B. `https://deinname.github.io/aperol-sprintz/`.

### Variante B: mit dem Terminal

Repository leer angelegt (noch nichts hochgeladen)? Dann direkt loslegen:

```sh
cd ~/Documents/Dev/ClaudeProjects/mallorca-places
git init -b main
git add .
git commit -m "Aperol Sprintz"
git remote add origin https://github.com/DEINNAME/aperol-sprintz.git
git push -u origin main
```

Repository schon über den Browser befüllt (z. B. Variante A)? Dann im nächsten Abschnitt (3a) den
Absatz „Einmalig verbinden“ verwenden – dort mit `--force`, weil GitHub sonst einen bestehenden Commit
meldet, von dem der lokale Ordner noch nichts weiß.

Danach wie in Variante A, Schritt 4, GitHub Pages einschalten.

**Später etwas geändert?** Am einfachsten mit `./deploy.sh` – siehe nächster Abschnitt.

---

## 3a. Automatisch hochladen mit `./deploy.sh`

Für jede weitere Änderung reicht danach **ein Befehl im Terminal**: `./deploy.sh`. Es erhöht die
Versionsnummer in `index.html` automatisch, speichert alle Änderungen in Git und lädt sie zu GitHub
hoch. Nach 1–2 Minuten ist die Online-Seite aktuell.

### Einmalig: dieses Projekt mit dem bestehenden GitHub-Repository verbinden

Hast du dein Repository bereits über den Browser angelegt (z. B. mit Variante A, oder es existiert
schon von früher), ist dieser Ordner hier noch **kein** Git-Repository und weiß noch nichts von GitHub.
Das einmalig verbinden:

1. Auf GitHub die Adresse deines Repositorys kopieren (grüner **Code**-Button → **HTTPS**), z. B.
   `https://github.com/DEINNAME/aperol-sprintz.git`.
2. Im Terminal:

   ```sh
   cd ~/Documents/Dev/ClaudeProjects/mallorca-places
   git init -b main
   git add -A
   git commit -m "Aperol Sprintz"
   git remote add origin https://github.com/CCodeL9876/aperol-sprintz
   git push -u origin main --force
   ```

   Das `--force` am Ende überschreibt den Stand auf GitHub einmalig mit dem, was gerade lokal auf
   deinem Mac liegt. Das ist hier gewollt und unbedenklich: Es ist dein eigenes Ein-Personen-Projekt,
   niemand sonst arbeitet parallel in diesem Repository, und der lokale Stand ist ohnehin der aktuellere.
   Ohne `--force` meldet Git sonst einen Konflikt, weil GitHub (durch das Hochladen im Browser) schon
   einen eigenen ersten Commit hat, von dem dein lokaler Ordner nichts weiß.

3. Beim `push` fragt der Terminal einmalig nach Benutzername und Passwort. GitHub akzeptiert hier
   **kein normales Passwort mehr**, sondern ein **Personal Access Token**:
   - Auf GitHub: **Settings → Developer settings → Personal access tokens → Tokens (classic) →
     Generate new token**.
   - Ein Ablaufdatum wählen (z. B. 1 Jahr) und das Häkchen bei **repo** setzen.
   - **Generate token**, den langen Code kopieren (wird nur einmal angezeigt).
   - Im Terminal beim Passwort-Prompt diesen Code einfügen (nicht das normale GitHub-Passwort).

   Danach merkt sich der Mac das Token in der Schlüsselbund-Verwaltung – du wirst nicht noch einmal
   gefragt, auch nicht bei künftigen `./deploy.sh`-Aufrufen.

Ab jetzt reicht nach jeder Änderung:

```sh
./deploy.sh
```

oder mit eigener Beschreibung, was sich geändert hat:

```sh
./deploy.sh "Neue Kategorie Weingüter hinzugefügt"
```

---

## 4. Gemeinsame Reise starten

1. Die GitHub-Pages-Adresse am Mac öffnen.
2. **Importieren** → die Backup-Datei aus Schritt 1 hineinziehen. Jetzt sind deine Orte auf der Online-Seite.
3. Oben auf **Teilen** tippen, deinen Namen eintragen und **Gemeinsame Reise starten** wählen.
   Die Orte werden in die Datenbank hochgeladen.
4. **Link kopieren** und per WhatsApp, iMessage o. Ä. an die Mitreisenden schicken.
   Der Link sieht so aus: `https://deinname.github.io/aperol-sprintz/#reise=3f9a…`

Wer den Link öffnet, sieht dieselben Orte und kann Orte importieren, hinzufügen, die Art ändern
oder löschen. Änderungen der anderen erscheinen spätestens nach 20 Sekunden (oder sofort beim
Zurückkehren in die App). Der Knopf oben heißt dann **Gemeinsam** und ist grün.

Unterkunft und die Box **Hin- & Rückreise** (Datum/Uhrzeit der Flüge) werden automatisch mitgeteilt –
dafür ist kein zusätzlicher Schritt nötig.

### Auf dem iPhone wie eine App nutzen

1. Den Reise-Link in **Safari** öffnen.
2. Teilen-Symbol → **Zum Home-Bildschirm**.
3. Die App startet danach im Vollbild, direkt in der gemeinsamen Reise.

---

## 5. Google Maps testen (optional)

Standard bleibt die OpenStreetMap-Karte. Die Google-Variante lässt sich zusätzlich zum Ausprobieren einschalten
und bietet: Google-Kartenbild, Satellit, Radwege-Ebene, antippbare Restaurants/Cafés mit Bewertung und
Öffnungszeiten sowie „Zu unseren Orten hinzufügen“.

**Einmalig einrichten (ca. 15 Minuten):**

1. <https://console.cloud.google.com> öffnen, oben **Projekt auswählen → Neues Projekt**, z. B. „Aperol Sprintz“.
2. **Abrechnung** mit dem Projekt verknüpfen (Kreditkarte nötig). Google gewährt monatliche Gratis-Kontingente –
   für eine kleine Reisegruppe fallen nach aktuellem Stand keine Kosten an; aktuelle Bedingungen bei Google prüfen.
3. **APIs & Dienste → Bibliothek**: **„Maps JavaScript API“** und **„Places API (New)“** aktivieren.
4. **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → API-Schlüssel**. Danach den Schlüssel **einschränken**:
   - *Anwendungseinschränkungen*: **Websites**, dann beide Adressen eintragen:
     `https://ccodel9876.github.io/aperol-sprintz/*` und `http://localhost:5173/*`
   - *API-Einschränkungen*: **Schlüssel einschränken** → nur „Maps JavaScript API“ und „Places API (New)“.
5. Empfohlen: **Abrechnung → Budgets & Benachrichtigungen** → Budget z. B. 5 € mit E-Mail-Warnung anlegen.
6. Den Schlüssel in `js/config.js` bei `GOOGLE_MAPS_API_KEY = '…'` eintragen und `./deploy.sh` ausführen.

Der Schlüssel steht danach öffentlich im Quellcode – das ist bei Google Maps so vorgesehen. Durch die
Einschränkung in Schritt 4 funktioniert er nur auf deiner Seite und nur für diese beiden Dienste.

**Umschalten:** Menü **„•••“ → „Google Maps testen“**, zurück mit **„Zurück zu OpenStreetMap“**. Die Wahl merkt sich
jedes Gerät bzw. jeder Browser selbst; andere sehen weiterhin OpenStreetMap, bis sie selbst umschalten.
Alternativ direkt per Adresse: `…/aperol-sprintz/?karte=google` bzw. `?karte=osm` (der `#reise=…`-Teil bleibt dahinter).

## Sicherheit in einem Satz

Der Reise-Link **ist** der Schlüssel: Wer ihn hat, kann mitplanen – teile ihn also nur mit Leuten, die
mitmachen sollen. Soll jemand keinen Zugriff mehr haben, starte eine neue gemeinsame Reise
(Menü **•••** → Backup herunterladen, dann **Teilen → Reise auf diesem Gerät verlassen**, Backup
importieren und neu teilen).

## Ohne Supabase?

Die App läuft auch ohne Datenbank online. Dann hat aber jede Person und jedes Gerät eine eigene Liste,
und Orte gehen verloren, wenn Browserdaten gelöscht werden. Zum gemeinsamen Planen ist Supabase nötig.
