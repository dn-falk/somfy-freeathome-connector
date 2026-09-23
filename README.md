# Somfy-TaHoma-Connector für free@home (inoffiziell)

free@home-Addon für den **System Access Point 2.0**, das **Somfy-io-Rollläden** über die lokale API
(Developer Mode) einer **Somfy TaHoma Switch** steuert. Jeder Rollladen erscheint in free@home als
normaler Rollladenaktor und lässt sich mit free@home-Tastern, in der App, in Szenen und
Zeitprogrammen verwenden.

> **Inoffizielles Projekt:** Dieses Addon ist ein privates Community-Projekt. Es wird weder von Somfy
> noch von ABB/Busch-Jaeger entwickelt, geprüft, unterstützt oder empfohlen und steht in keiner
> Verbindung zu diesen Unternehmen. Die Markennamen werden nur genannt, um zu beschreiben, mit welchen
> Produkten das Addon zusammenarbeitet. Details unter
> [Lizenz und rechtliche Hinweise](#lizenz-und-rechtliche-hinweise).

- **Lokal und ohne Cloud:** Das Addon läuft auf dem SysAP und spricht die TaHoma Switch direkt im
  Heimnetz an.
- **Kurze Reaktionszeit:** Ein Tastendruck wird sofort als Befehl an die Box geschickt. Es gibt kein
  Polling im Steuerpfad, und die Verbindungen bleiben offen (Keep-Alive).
- **Rückmeldung:** Position und Fahrtrichtung werden in free@home angezeigt, auch wenn der Rollladen
  über eine Somfy-Fernbedienung oder die TaHoma-App bewegt wurde.
- **Konfiguration komplett in der Addon-Oberfläche** der free@home-App bzw. der SysAP-Weboberfläche.

> Das Somfy **Connectivity Kit** wird nicht unterstützt. Somfy hat den Developer Mode auf dem Kit
> abgeschaltet, es gibt dort keine lokale API mehr.

## Funktionen

| free@home | Wirkung am Somfy-Rollladen |
|---|---|
| Taster **lang** drücken (auf/ab) | `open` / `close`: fährt ganz auf bzw. zu |
| Taster **kurz** drücken, Rollladen fährt | `stop` |
| Taster **kurz** drücken, Rollladen steht | einstellbar: nur Stopp (Standard), Lieblingsposition „my“ oder ganz auf/zu |
| Position in App, Szene oder Zeitprogramm | `setClosure(x)`, bei 0 % bzw. 100 % `open` / `close` |
| Zwangsführung auf/ab | fährt in die Position und sperrt die Bedienung; „Zwangsführung aus + alte Position“ fährt zurück |
| Rollladen oder Box nicht erreichbar | Rollladen wird in free@home als „nicht erreichbar“ angezeigt |

Befehle für mehrere Rollläden, die gleichzeitig eintreffen (ein Taster für mehrere Rollläden,
Szenen), werden in **einer** Anfrage an die Box gebündelt.

## Voraussetzungen

- free@home **System Access Point 2.0** mit Firmware **3.0 oder neuer**
- In der free@home-next-App: **Mehr → Installationseinstellungen → Local API** aktiviert
- **Somfy TaHoma Switch** mit eingelernten **io-homecontrol-Rollläden**

## Installation

### 1. TaHoma Switch vorbereiten

1. Die TaHoma Switch in der App **„TaHoma by Somfy“** einrichten und die Rollläden einlernen.
   Beim Wechsel vom Connectivity Kit werden die Rollläden an der neuen Box eingelernt (siehe
   Anleitung von Somfy).
2. **Developer Mode aktivieren:** In der App die Einstellungen der Box öffnen und **7× auf die PIN**
   der Box tippen (z. B. `2001-1234-5678`).
3. Im Menü **Developer Mode** einen **Token erzeugen** und kopieren. Er wird nur einmal angezeigt.
4. Im Router der TaHoma Switch eine **feste IP-Adresse** zuweisen (DHCP-Reservierung).

### 2. Addon-Archiv bauen

Das installierbare Archiv ist eine `.tar`-Datei. Voraussetzung ist Node.js ab Version 18:

```bash
npm ci
npm run pack
```

Das erzeugt `de.dnfalk.freeathome.somfy-<version>.tar`. Alternativ liegt das Archiv als Artefakt am
GitHub-Actions-Lauf bzw. an einem Release.

### 3. Addon hochladen

- **free@home-next-App:** Mehr → Installationseinstellungen → Addons → **Hochladen**, dann die
  `.tar`-Datei auswählen.
- oder über die **Weboberfläche** des System Access Point
- oder per Kommandozeile:
  `FREEATHOME_BASE_URL=http://<IP-SysAP> FREEATHOME_API_USERNAME=<Benutzer> FREEATHOME_API_PASSWORD=<Passwort> npx free-at-home-cli upload`

Danach erscheint das Addon in der Addon-Liste als **„Somfy-TaHoma-Connector (inoffiziell)“** und muss
als **aktiv** angezeigt werden.

### 4. Einstellungen

In den Einstellungen des Addons:

| Einstellung | Bedeutung |
|---|---|
| **IP-Adresse** | IP der TaHoma Switch, z. B. `192.168.1.50` |
| **Port** | `8443` (Standard der lokalen API) |
| **Token** | Token aus dem Developer Mode |
| PIN der Box (optional) | z. B. `2001-1234-5678`. Damit wird zusätzlich geprüft, ob das Zertifikat zu genau dieser Box gehört. |
| Zertifikat prüfen | Standard an: nur Boxen mit Zertifikat der Somfy/Overkiz-CA werden akzeptiert |
| Kurzer Tastendruck, wenn der Rollladen steht | nur Stopp (Standard) · Lieblingsposition (my) · ganz auf/zu |
| Ausgeschlossene Rollläden | kommagetrennte Namen aus der TaHoma-App, die nicht in free@home erscheinen sollen |
| Statusabfrage im Ruhezustand | Abfrageintervall für Änderungen, solange nichts fährt (Standard 3 s, während einer Fahrt 1 s). Befehle werden unabhängig davon **sofort** gesendet. |
| Bündelung von Gruppenbefehlen | Zeitfenster, in dem Befehle für mehrere Rollläden zusammengefasst werden (Standard 10 ms) |
| Debug-Protokoll | ausführliche Meldungen im Journal des SysAP |

Nach dem Speichern verbindet sich das Addon. Die Zeile **Status** zeigt z. B. „Verbunden, 5 Rollläden“.
**Rollläden neu einlesen** übernimmt neu eingelernte Rollläden aus der TaHoma, ohne das Addon neu zu
starten. Das passiert auch automatisch, wenn die Box das Hinzufügen oder Entfernen eines Geräts meldet.

### 5. In free@home verwenden

- Die Rollläden erscheinen mit ihrem Namen aus der TaHoma-App als **Rollladenaktoren** in der
  Geräteliste. Dort wie gewohnt einem Raum zuordnen und bei Bedarf umbenennen.
- **Taster verknüpfen:** Den Rollladen- bzw. Jalousie-Sensor (Taster) mit dem Rollladen verknüpfen,
  genauso wie bei einem echten free@home-Aktor.
- Szenen und Zeitprogramme funktionieren wie bei anderen Aktoren: Der SysAP behandelt die
  virtuellen Geräte des Addons wie echte Geräte.

Die free@home-Geräte-ID wird aus der io-Adresse des Motors gebildet (`somfy-io-<adresse>`). Wird die
Box getauscht und der Motor neu eingelernt, bleiben Geräte und Verknüpfungen in free@home erhalten.

## Fehlerbehebung

| Status / Symptom | Ursache und Lösung |
|---|---|
| „Konfiguration nötig: …“ | IP-Adresse oder Token fehlt bzw. ist ungültig. |
| „Token wird von der TaHoma Switch abgelehnt“ | Token falsch oder in der App gelöscht → neuen Token erzeugen und eintragen. |
| „TaHoma Switch nicht erreichbar“ | IP prüfen (feste IP?), Box eingeschaltet? Nach Firmware-Updates prüfen, ob der Developer Mode noch aktiv ist. Das Addon verbindet sich automatisch neu. |
| Zertifikatsfehler im Journal | PIN der Box prüfen; notfalls „Zertifikat prüfen“ ausschalten. |
| Rollladen fehlt | Nur io-Rollläden (Geräteklasse „RollerShutter“) werden übernommen. „Ausgeschlossene Rollläden“ prüfen, dann „Rollläden neu einlesen“. |
| Rollladen „nicht erreichbar“ | Die Box meldet den Motor als nicht erreichbar (Funk, Stromausfall). |

Die Meldungen des Addons stehen im Journal des SysAP. Mit gesetzten `FREEATHOME_*`-Variablen
zeigt `npm run journal` sie an. Für Details in den Einstellungen das **Debug-Protokoll** einschalten.

## Einschränkungen

- Unterstützt werden **io-homecontrol-Rollläden** (`io://…`, Geräteklasse `RollerShutter`).
  RTS-Motoren, Raffstores/Jalousien mit Lamellen und Markisen werden nicht angelegt.
- Getestet wurde mit Unit- und Integrationstests gegen eine simulierte TaHoma Switch und einen
  simulierten System Access Point, jeweils mit der echten free@home-Library. Ein Test mit echter
  Hardware steht noch aus.
- **Speicher:** Der SysAP erlaubt einem Addon höchstens 64 MB. Auf einem x86-64-PC mit Node 18 belegt
  das Addon mit 12 Rollläden etwa 60–65 MB (kurzzeitig bis ~70 MB). Davon entfallen rund 44 MB auf
  Node.js selbst und der größte Teil des Rests auf die free@home-Library; der Addon-Code macht nur
  wenig aus. Auf dem ARM-basierten SysAP weichen die Werte ab und müssen dort noch geprüft werden.
  Das Addon lädt deshalb nur die benötigten Teile der Library.

## Entwicklung

```bash
npm ci
npm test            # Unit- und Integrationstests (TaHoma-Simulator, Fake-SysAP, echte free@home-Library)
npm run build       # TypeScript -> build/
npm run pack        # installierbares Addon-Archiv (.tar)
```

**Addon auf dem PC gegen den eigenen SysAP laufen lassen.** Das Addon darf dabei nicht
gleichzeitig auf dem SysAP laufen, sonst entstehen doppelte Geräte.

```bash
export FREEATHOME_BASE_URL=http://<IP-SysAP>
export FREEATHOME_API_USERNAME=<Benutzer der Local API>
export FREEATHOME_API_PASSWORD=<Passwort>
npm run build && npm start
```

**Ohne TaHoma Switch:** `npm run mock -- --port 18443 --token dev-token --shutters "Wohnzimmer,Küche"`
startet eine simulierte Box mit Fahrzeiten und Rückmeldungen. Das Addon dann mit
`TAHOMA_INSECURE_HTTP=1 npm start` starten (unverschlüsseltes HTTP, nur für die Entwicklung) und in
den Einstellungen IP des PCs, Port `18443` und Token `dev-token` eintragen.

### Aufbau

```
src/
  main.ts                  Einstieg: free@home-Library, Addon-Konfiguration, RPC, Signale
  app.ts                   (Neu-)Start der Verbindung bei Konfigurationsänderungen, Status
  config.ts                Einstellungen aus der Addon-Oberfläche lesen und prüfen
  status.ts                Statusanzeige (Einstellungen, Application State)
  bridge/bridge.ts         TaHoma-Geräte <-> virtuelle free@home-Aktoren
  bridge/shutterController.ts  Steuerlogik je Rollladen (Taster, Position, Stopp, Zwangsführung, Rückmeldung)
  fah/                     virtueller free@home-Rollladenaktor, Datenpunkte, Geräte-Registry
  tahoma/                  Client der lokalen TaHoma-API (HTTPS, Overkiz-CA), Befehlswarteschlange, Event-Session
test/                      Tests inkl. TaHoma-Simulator und Fake-System-Access-Point
tools/mock-tahoma.ts       simulierte TaHoma Switch für die Entwicklung
```

## Lizenz und rechtliche Hinweise

- **Kein offizielles Produkt:** Dieses Addon ist ein unabhängiges Community-Projekt. Es ist kein
  Produkt von Somfy oder ABB/Busch-Jaeger. Diese Unternehmen haben es weder beauftragt noch geprüft,
  zertifiziert oder freigegeben, und sie leisten dafür keinen Support.
- **Support:** Fragen und Fehlerberichte bitte über die
  [Issues](https://github.com/dn-falk/somfy-freeathome-connector/issues) dieses Repositorys melden,
  nicht beim Support von Somfy oder Busch-Jaeger.
- **Marken:** Somfy, TaHoma, io-homecontrol, Overkiz, free@home, Busch-free@home, Busch-Jaeger und
  ABB sind Marken bzw. eingetragene Marken ihrer jeweiligen Inhaber. Sie werden hier nur verwendet,
  um zu beschreiben, mit welchen Produkten das Addon zusammenarbeitet. Daraus ergibt sich keine
  Verbindung zu den Markeninhabern und keine Empfehlung durch sie. Logos der Hersteller werden nicht
  verwendet.
- **Schnittstellen:** Das Addon nutzt ausschließlich offiziell dokumentierte Schnittstellen: die
  lokale API der TaHoma Switch (Somfy Developer Mode) sowie die Local API und die Addon-Schnittstelle
  des free@home System Access Point.
- **Lizenz und Haftung:** MIT-Lizenz, siehe [LICENSE](LICENSE). Die Software wird ohne jede
  Gewährleistung bereitgestellt; die Nutzung erfolgt auf eigene Gefahr.
