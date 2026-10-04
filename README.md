# Somfy-TaHoma-Connector for free@home (unofficial)

**English** | [Deutsch](README.de.md)

free@home addon for the **System Access Point 2.0 and 3.0** that controls **Somfy io roller shutters** through
the local API (Developer Mode) of a **Somfy TaHoma Switch**. Every roller shutter shows up in
free@home as a regular blind actuator and can be used with free@home push buttons, in the app, in
scenes and in timers.

> **Unofficial project:** This addon is a private community project. It is not developed, reviewed,
> supported or endorsed by Somfy or ABB/Busch-Jaeger and is not affiliated with these companies. The
> brand names are only used to describe which products the addon works with. See
> [License and legal notes](#license-and-legal-notes).

- **Local, no cloud:** The addon runs on the SysAP and talks to the TaHoma Switch directly in the
  home network.
- **Fast response:** A button press is sent to the box as a command right away. There is no polling
  in the control path, and the connections are kept open (keep-alive).
- **Feedback:** Position and direction of travel are shown in free@home, even when the shutter was
  moved with a Somfy remote or the TaHoma app.
- **Configured entirely in the addon settings** of the free@home app or the SysAP web interface.

> The Somfy **Connectivity Kit** is not supported. Somfy has disabled the Developer Mode on the kit,
> so it no longer has a local API.

## Features

| free@home | Effect on the Somfy roller shutter |
|---|---|
| **Long** press (up/down) | `open` / `close`: moves fully up or down |
| **Short** press while the shutter moves | `stop` |
| **Short** press while the shutter stands still | configurable: stop only (default), favourite position "my" or fully up/down |
| Position from the app, a scene or a timer | `setClosure(x)`; `open` / `close` for 0 % and 100 % |
| Forced position up/down | moves to that position and locks operation; "forced position off + previous position" moves back |
| Shutter or box not reachable | the shutter is shown as "not reachable" in free@home |

Commands for several shutters that arrive at the same time (one push button for several shutters,
scenes) are sent to the box in **one** request.

## Requirements

- free@home **System Access Point 2.0** (firmware **3.0 or later**) or **System Access Point 3.0**
- In the free@home next app: **More → Installation settings → Local API** enabled
- **Somfy TaHoma Switch** with paired **io-homecontrol roller shutters**

## Installation

### 1. Prepare the TaHoma Switch

1. Set up the TaHoma Switch in the **"TaHoma by Somfy"** app and pair the roller shutters. When
   switching from the Connectivity Kit, the shutters are paired with the new box (see Somfy's
   instructions).
2. **Enable the Developer Mode:** In the app, open the settings of the box and **tap the PIN** of the
   box **7 times** (e.g. `2001-1234-5678`).
3. In the **Developer Mode** menu, **generate a token** and copy it. It is shown only once.
4. Give the TaHoma Switch a **fixed IP address** in your router (DHCP reservation).

### 2. Download the addon archive

The installable archive is a `.tar` file. Download `somfy-tahoma-connector-<version>.tar`
from the [latest release](https://github.com/dn-falk/somfy-freeathome-connector/releases/latest).

To build it yourself instead (Node.js 18 or later):

```bash
npm ci
npm run pack
```

### 3. Upload the addon

- **free@home next app:** More → Installation settings → Addons → **Upload**, then select the
  `.tar` file.
- or through the **web interface** of the System Access Point
- or from the command line:
  `FREEATHOME_BASE_URL=http://<SysAP-IP> FREEATHOME_API_USERNAME=<user> FREEATHOME_API_PASSWORD=<password> npx free-at-home-cli upload`

The addon then appears in the addon list as **"Somfy-TaHoma-Connector (unofficial)"** and must be
shown as **active**.

### 4. Settings

In the settings of the addon:

| Setting | Meaning |
|---|---|
| **IP address** | IP of the TaHoma Switch, e.g. `192.168.1.50` |
| **Port** | `8443` (default of the local API) |
| **Token** | Token from the Developer Mode |
| Gateway PIN (optional) | e.g. `2001-1234-5678`. Additionally checks that the certificate belongs to exactly this box. |
| Verify certificate | On by default: only boxes with a certificate from the Somfy/Overkiz CA are accepted |
| Short press while the shutter is not moving | only stop (default) · favourite position (my) · fully up/down |
| Excluded roller shutters | comma-separated names from the TaHoma app that should not appear in free@home |
| Status update interval while idle | how often the addon asks for changes while nothing moves (default 3 s, 1 s while a shutter moves). Commands are always sent **immediately**, independent of this setting. |
| Group commands window | time window in which commands for several shutters are combined (default 10 ms) |
| Debug logging | detailed messages in the log of the addon, including every feedback of the box with the time since the command |

After saving, the addon connects. The **Status** line shows e.g. "Connected, 5 roller shutter(s)".
**Reload roller shutters** adds newly paired shutters from the TaHoma without restarting the
addon. This also happens automatically when the box reports that a device was added or removed.

### 5. Use in free@home

- The roller shutters appear in the device list as **blind actuators**, named as in the TaHoma
  app. Assign them to a room and rename them if needed, as usual.
- **Link push buttons:** Link the blind sensor (push button) with the roller shutter, just like with
  a real free@home actuator.
- Scenes and timers work as with other actuators: the SysAP treats the virtual devices of the addon
  like real devices.

The free@home device ID is derived from the io address of the motor (`somfy-io-<address>`). If the
box is replaced and the motor is paired again, the devices and links in free@home are kept.

## Troubleshooting

| Status / symptom | Cause and solution |
|---|---|
| "Configuration needed: …" | IP address or token is missing or invalid. |
| "Token rejected by the TaHoma Switch" | Wrong token, or it was deleted in the app → generate a new token and enter it. |
| "TaHoma Switch not reachable" | Check the IP (fixed IP?) and whether the box is switched on. After firmware updates, check that the Developer Mode is still active. The addon reconnects automatically. |
| Certificate errors in the journal | Check the gateway PIN; if necessary, turn off "Verify certificate". |
| Roller shutter missing | Only io roller shutters (device class "RollerShutter") are included. Check "Excluded roller shutters", then use "Reload roller shutters". |
| Roller shutter "not reachable" | The box reports the motor as not reachable (radio, power failure). |
| Roller shutter reacts only after about a second | The addon passes a command on to the box within about 0.1 s after receiving it from free@home. The rest of the time passes before that in free@home (push button → SysAP → addon) and afterwards in the TaHoma Switch (box → radio → motor); in a test, the TaHoma app did not stop the shutter noticeably faster either. With **Debug logging**, every feedback of the box is logged with the time since the command. |
| "Log" tab in the addon settings stays empty | **Download** there provides the complete log as a file. |

The addon writes its messages to the SysAP journal. In the addon settings, **Log → Download** saves
them as a file; with the `FREEATHOME_*` variables set, `npm run journal` shows them. For details,
turn on **Debug logging** in the settings.

## Limitations

- Only **io-homecontrol roller shutters** (`io://…`, device class `RollerShutter`) are supported.
  RTS motors, venetian blinds with slats and awnings are not added to free@home.
- Tested with unit and integration tests against a simulated TaHoma Switch and a simulated System
  Access Point, both with the real free@home library, and on a real installation (System Access
  Point, TaHoma Switch, two io roller shutters).
- **Memory:** The SysAP allows an addon at most 64 MB. On an x86-64 PC with Node 18 the addon uses
  about 60–65 MB with 12 shutters (briefly up to ~70 MB). About 44 MB of this is Node.js itself and
  most of the rest is the free@home library; the addon code itself accounts for little. On the
  ARM-based SysAP the values differ and still have to be checked there. For this reason the addon
  loads only the parts of the library it needs.

## Development

```bash
npm ci
npm test            # unit and integration tests (TaHoma simulator, fake SysAP, real free@home library)
npm run build       # TypeScript -> build/
npm run pack        # installable addon archive (.tar)
```

**Running the addon on a PC against your own SysAP.** The addon must not run on the SysAP at the
same time, otherwise devices are duplicated.

```bash
export FREEATHOME_BASE_URL=http://<SysAP-IP>
export FREEATHOME_API_USERNAME=<Local API user>
export FREEATHOME_API_PASSWORD=<password>
npm run build && npm start
```

**Without a TaHoma Switch:** `npm run mock -- --port 18443 --token dev-token --shutters "Living room,Kitchen"`
starts a simulated box with travel times and feedback. Then start the addon with
`TAHOMA_INSECURE_HTTP=1 npm start` (unencrypted HTTP, for development only) and enter the IP of the
PC, port `18443` and token `dev-token` in the settings.

### Releases

Releases are created by GitHub Actions. When `main` contains a version that has not been released
yet, CI runs the tests, builds the archive and publishes the release `v<version>` with the file
`somfy-tahoma-connector-<version>.tar`. To publish a new version, increase the version on a branch
and merge it into `main`:

```bash
npm version 1.1.0 --no-git-tag-version   # package.json and package-lock.json
# and set the same "version" in free-at-home-metadata.json
```

### Structure

```
src/
  main.ts                  entry point: free@home library, addon configuration, RPC, signals
  app.ts                   (re)starts the connection on configuration changes, status
  config.ts                reads and checks the settings from the addon UI
  status.ts                status display (settings, application state)
  bridge/bridge.ts         TaHoma devices <-> virtual free@home actuators
  bridge/shutterController.ts  control logic per shutter (push buttons, position, stop, forced position, feedback)
  fah/                     virtual free@home blind actuator, datapoints, device registry
  tahoma/                  client for the local TaHoma API (HTTPS, Overkiz CA), command queue, event session
test/                      tests incl. TaHoma simulator and fake System Access Point
tools/mock-tahoma.ts       simulated TaHoma Switch for development
```

## License and legal notes

- **Not an official product:** This addon is an independent community project. It is not a product
  of Somfy or ABB/Busch-Jaeger. These companies did not commission, review, certify or approve it,
  and they do not provide support for it.
- **Support:** Please report questions and bugs through the
  [issues](https://github.com/dn-falk/somfy-freeathome-connector/issues) of this repository, not to
  Somfy or Busch-Jaeger support.
- **Trademarks:** Somfy, TaHoma, io-homecontrol, Overkiz, free@home, Busch-free@home, Busch-Jaeger and
  ABB are trademarks or registered trademarks of their respective owners. They are only used here to
  describe which products the addon works with. This implies no affiliation with the trademark
  owners and no endorsement by them. No manufacturer logos are used.
- **Interfaces:** The addon only uses officially documented interfaces: the local API of the TaHoma
  Switch (Somfy Developer Mode) and the Local API and addon interface of the free@home System Access
  Point.
- **License and liability:** MIT license, see [LICENSE](LICENSE). The software is provided without
  any warranty; use at your own risk.
