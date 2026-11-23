# Askesis – stoisches Training

Askesis ist eine installierbare Web-App (PWA) für Handy und Computer. Du trainierst Ganzkörper mit dem eigenen Körpergewicht, an drei Tagen pro Woche, mit Tag A und B im Wechsel. Dazu hakst du deine Gewohnheiten ab und trägst Körperwerte ein. Am Laptop siehst du eine ausführliche Auswertung. Alles wird über dasselbe Supabase-Projekt synchronisiert wie das Stoische Journal und nutzt dasselbe Konto.

*Askesis* (ἄσκησις) ist bei den Stoikern die Übung, durch die Charakter entsteht.

Die App braucht keinen Build-Schritt: Was in diesem Ordner liegt, wird genau so veröffentlicht.

## Training und Progression
- Es gibt zwei Tage: **A** (Liegestütz, Kniebeuge, Rudern, Glute Bridge, Unterarmstütz) und **B** (Pike Push-up, Ausfallschritt, Rudern bzw. Klimmzug, Hollow Hold, Seitstütz).
- Jede Übung ist eine **Leiter** mit Stufen von leicht bis schwer. Die Stufen stehen in `js/plan.js`.
- Die Progression läuft über die Wiederholungen bzw. Sekunden. Vorausgefüllt ist immer der letzte Wert. Der schwächste Satz bekommt +1 Wiederholung bzw. +5 s.
- Wenn alle Sätze den oberen Rand des Zielbereichs erreichen, schlägt die App die nächste Stufe vor.

## Lokal ausprobieren
```powershell
python -m http.server 8001
```
Danach http://localhost:8001/?lokal öffnen. Mit `?lokal` läuft die App auf localhost **ohne Login und ohne Sync**. Port 8001 wird genommen, weil das Journal auf Port 8000 läuft.

## Einrichtung
### 1. Supabase
Es wird dasselbe Projekt wie beim Journal genutzt, `js/config.js` enthält schon die Werte.
1. Links **SQL Editor** öffnen → **New query**.
2. Den Inhalt von `supabase/fitness.sql` einfügen und **Run** klicken.

Dabei entstehen fünf Tabellen, die alle mit `fit_` beginnen. Row Level Security ist eingeschaltet.

### 2. GitHub Pages
1. Auf GitHub ein öffentliches Repository `stoic-fitness` anlegen und diesen Ordner pushen.
2. Unter **Settings → Pages** die Quelle **Deploy from a branch** wählen, mit `main` und `/ (root)`.
3. Danach ist die App unter `https://niclasd-stack.github.io/stoic-fitness/` erreichbar.
4. Optional: Die Adresse in Supabase unter **Authentication → URL Configuration → Redirect URLs** eintragen. Das ist nur nötig, wenn du dich aus dieser App heraus neu registrieren willst.

### 3. Installieren
- **Android:** Die URL in Chrome öffnen → Menü ⋮ → **App installieren**.
- **PC:** In Chrome oder Edge auf das Installieren-Symbol in der Adressleiste klicken.

## Zusammenleben mit dem Journal
Beide Apps liegen auf derselben Origin (`niclasd-stack.github.io`).
- **Anmeldung:** Die Anmeldung ist geteilt. Wer im Journal angemeldet ist, ist es auch hier. **Abmelden meldet in beiden Apps ab.**
- **Speicher:** Die lokale Datenbank heißt `stoic-fitness`. Die Offline-Caches beginnen mit `fit-`. Das Journal räumt seit Version v5 seines Service Workers nur noch seine eigenen Caches auf.

## Updates veröffentlichen
Nach jeder Änderung in `sw.js` die `VERSION` erhöhen, z. B. `v2`, und dann pushen.

## Datenschutz
Die Daten liegen in deinem Supabase-Projekt, und jedes Konto sieht nur seine eigenen Einträge. Über **Mehr → Backup exportieren** bekommst du alles als JSON-Datei.
