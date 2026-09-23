import { BridgeStatus } from "./bridge/bridge";
import { Message } from "./config";
import { errorMessage } from "./log";
import { TahomaError } from "./tahoma/errors";

export type AddonStatus =
    | { state: "starting" }
    | { state: "configurationNeeded"; problems: Message[] }
    | { state: "connecting" }
    | { state: "online"; shutterCount: number; protocolVersion?: string }
    | { state: "offline"; error: string; authError: boolean };

export function fromBridgeStatus(status: BridgeStatus): AddonStatus {
    switch (status.state) {
        case "online":
            return { state: "online", shutterCount: status.shutterCount, protocolVersion: status.protocolVersion };
        case "offline":
            return {
                state: "offline",
                error: status.error ? errorMessage(status.error) : "unknown error",
                authError: status.error instanceof TahomaError && status.error.kind === "auth",
            };
        default:
            return { state: "connecting" };
    }
}

export function describeStatus(status: AddonStatus): Message {
    switch (status.state) {
        case "starting":
            return { en: "Starting", de: "Wird gestartet" };
        case "configurationNeeded": {
            const problems = status.problems.length > 0 ? status.problems : [{ en: "settings missing", de: "Einstellungen fehlen" }];
            return {
                en: `Configuration needed: ${problems.map((problem) => problem.en).join(", ")}`,
                de: `Konfiguration nötig: ${problems.map((problem) => problem.de).join(", ")}`,
            };
        }
        case "connecting":
            return { en: "Connecting to the TaHoma Switch …", de: "Verbinde mit der TaHoma Switch …" };
        case "online":
            return {
                en: `Connected, ${status.shutterCount} roller shutter(s)`,
                de: `Verbunden, ${status.shutterCount} Rollläden`,
            };
        case "offline":
            return status.authError
                ? { en: `Token rejected by the TaHoma Switch (${status.error})`, de: `Token wird von der TaHoma Switch abgelehnt (${status.error})` }
                : { en: `TaHoma Switch not reachable (${status.error})`, de: `TaHoma Switch nicht erreichbar (${status.error})` };
    }
}

/** Parameter configuration returned by the `getParameterConfig` RPC for the status field. */
export function statusParameter(status: AddonStatus): Record<string, unknown> {
    const text = describeStatus(status);
    const isError = status.state === "offline" || status.state === "configurationNeeded";
    return {
        name: text.en,
        "name@de": text.de,
        type: isError ? "error" : "text",
        rpc: "getParameterConfig",
        rpcCallOn: "initial",
    };
}

/** Application state shown by the System Access Point for the addon. */
export function applicationState(status: AddonStatus): Record<string, unknown> {
    const text = describeStatus(status).de;
    const id = status.state === "configurationNeeded" ? "configurationNeeded"
        : status.state === "offline" ? "error" : "ok";
    return { state: { id, text } };
}
