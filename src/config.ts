import { ShortPressIdleAction } from "./bridge/shutterController";
import { parseExcludedNames } from "./tahoma/rollerShutter";

export interface Settings {
    host: string;
    port: number;
    token: string;
    gatewayPin?: string;
    verifyCertificate: boolean;
    shortPressIdle: ShortPressIdleAction;
    excluded: string[];
    pollIntervalMs: number;
    batchWindowMs: number;
    debug: boolean;
}

export interface Message {
    en: string;
    de: string;
}

export type ConfigResult =
    | { ok: true; settings: Settings }
    | { ok: false; problems: Message[] };

export const DEFAULT_PORT = 8443;
const SHORT_PRESS_ACTIONS: readonly ShortPressIdleAction[] = ["stop", "my", "move"];
const GATEWAY_PIN = /^\d{4}-\d{4}-\d{4}$/;
const HOST = /^[a-zA-Z0-9.-]+$|^\[[0-9a-fA-F:]+\]$/;

type Items = Record<string, unknown>;

function groupItems(configuration: unknown, group: string): Items {
    if (!configuration || typeof configuration !== "object")
        return {};
    const entry = (configuration as Record<string, unknown>)[group];
    if (!entry || typeof entry !== "object")
        return {};
    const items = (entry as Record<string, unknown>).items;
    return items && typeof items === "object" ? items as Items : {};
}

function stringValue(value: unknown): string | undefined {
    if (typeof value === "string")
        return value.trim() || undefined;
    if (typeof value === "number")
        return String(value);
    return undefined;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
    const number = typeof value === "number" ? value
        : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(number))
        return fallback;
    return Math.min(max, Math.max(min, number));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean")
        return value;
    if (value === "true" || value === 1 || value === "1")
        return true;
    if (value === "false" || value === 0 || value === "0")
        return false;
    return fallback;
}

/**
 * Accepts "192.168.1.5", "192.168.1.5:8443", "https://gateway-1234-5678-9012.local:8443/" and
 * returns host and (optional) port.
 */
export function parseHost(input: string): { host: string; port?: number } | undefined {
    let text = input.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
    let port: number | undefined;
    const withPort = /^(.*):(\d{1,5})$/.exec(text);
    if (withPort && !withPort[1].includes(":")) {
        text = withPort[1];
        port = Number(withPort[2]);
    }
    if (!HOST.test(text))
        return undefined;
    return { host: text, port };
}

/** Reads the addon configuration (as sent by the System Access Point) into {@link Settings}. */
export function parseConfiguration(configuration: unknown): ConfigResult {
    const connection = groupItems(configuration, "connection");
    const behaviour = groupItems(configuration, "behaviour");
    const advanced = groupItems(configuration, "advanced");
    const problems: Message[] = [];

    const hostText = stringValue(connection.host);
    const host = hostText ? parseHost(hostText) : undefined;
    if (!hostText)
        problems.push({ en: "IP address of the TaHoma Switch is missing", de: "IP-Adresse der TaHoma Switch fehlt" });
    else if (!host)
        problems.push({ en: `invalid IP address '${hostText}'`, de: `ungültige IP-Adresse „${hostText}“` });

    const token = stringValue(connection.token);
    if (!token)
        problems.push({ en: "token is missing", de: "Token fehlt" });

    const gatewayPin = stringValue(connection.gatewayPin);
    if (gatewayPin && !GATEWAY_PIN.test(gatewayPin))
        problems.push({ en: "gateway PIN must look like 1234-5678-9012", de: "PIN der Box muss das Format 1234-5678-9012 haben" });

    if (problems.length > 0 || !host || !token)
        return { ok: false, problems };

    const shortPressText = stringValue(behaviour.shortPressIdle);
    const shortPressIdle = SHORT_PRESS_ACTIONS.find((action) => action === shortPressText) ?? "stop";

    return {
        ok: true,
        settings: {
            host: host.host,
            port: host.port ?? Math.round(numberValue(connection.port, DEFAULT_PORT, 1, 65535)),
            token,
            gatewayPin,
            verifyCertificate: booleanValue(connection.verifyCertificate, true),
            shortPressIdle,
            excluded: parseExcludedNames(stringValue(behaviour.excludedDevices)),
            pollIntervalMs: Math.round(numberValue(advanced.pollInterval, 3, 1, 60) * 1000),
            batchWindowMs: Math.round(numberValue(advanced.batchWindow, 10, 0, 250)),
            debug: booleanValue(advanced.debug, false),
        },
    };
}
