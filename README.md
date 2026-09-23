# somfy-freeathome-connector

free@home-Addon (System Access Point 2.0), um Somfy-Rollläden und -Jalousien wie normale free@home-Aktoren zu steuern: per Taster, App, Szene und Zeitprogramm. Eingerichtet wird alles über die Addon-Oberfläche des SysAP.

**Status:** Analysephase. Ergebnisse, Architektur und offene Fragen stehen in [docs/analyse.md](docs/analyse.md).

## Kernpunkte der Analyse

- Das **Somfy Connectivity Kit** hat seit Oktober 2025 **keine lokale API** mehr (TaHoma Developer Mode wurde von Somfy deaktiviert).
- Lokal erreichbar bleibt das Kit nur über **Apple HomeKit (HAP over IP)**. Das gilt nur für io-Geräte, ohne Stopp-Befehl, und die Kopplung ist exklusiv.
- Die robusteste Variante ist eine **TaHoma Switch** mit offizieller lokaler API. Für **RTS-Motoren** eignet sich auch **ESPSomfy-RTS**.
- Das Addon bekommt deshalb ein **austauschbares Somfy-Backend**. Die free@home-Seite (virtuelle Aktoren, Konfigurationsoberfläche) bleibt dabei gleich.
