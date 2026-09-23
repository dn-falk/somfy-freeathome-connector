import { StateNames, StateValue, TahomaDevice, TahomaState } from "./types";

/** `core:ClosureState` value while the shutter is at its "my" (favourite) position. */
export const CLOSURE_MY_POSITION = 108;
/** `core:ClosureState` value when the box does not know the position. */
export const CLOSURE_UNKNOWN = 124;

/**
 * The addon handles io-homecontrol roller shutters (uiClass `RollerShutter`). They report their
 * position and understand `open`, `close`, `stop`, `my` and `setClosure`.
 */
export function isSupportedRollerShutter(device: TahomaDevice): boolean {
    if (!device.deviceURL?.startsWith("io://"))
        return false;
    if (device.definition?.uiClass !== "RollerShutter")
        return false;
    if (device.enabled === false)
        return false;
    const commands = commandNames(device);
    return commands.has("open") && commands.has("close") && commands.has("stop");
}

export function commandNames(device: TahomaDevice): Set<string> {
    return new Set((device.definition?.commands ?? []).map((command) => command.commandName));
}

/** True if the device definition (or its current states) contains the given state. */
export function hasState(device: TahomaDevice, name: string): boolean {
    return (device.definition?.states ?? []).some((state) => state.name === name)
        || (device.states ?? []).some((state) => state.name === name);
}

export function findState(states: readonly TahomaState[] | undefined, name: string): StateValue | undefined {
    return states?.find((state) => state.name === name)?.value;
}

export function numberValue(value: StateValue | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}

export function booleanValue(value: StateValue | undefined): boolean | undefined {
    if (typeof value === "boolean")
        return value;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return undefined;
}

/** Availability from the device flag and `core:StatusState`. */
export function availabilityFromStates(states: readonly TahomaState[] | undefined): boolean | undefined {
    const status = findState(states, StateNames.status);
    if (status === "available")
        return true;
    if (status === "unavailable")
        return false;
    return undefined;
}

export function isDeviceAvailable(device: TahomaDevice): boolean {
    if (device.available === false)
        return false;
    return availabilityFromStates(device.states) ?? true;
}

/**
 * Stable free@home id for a device. The PIN of the box is left out, so the free@home devices
 * (and their links to push buttons) survive a replacement of the box as long as the motors
 * keep their io address. Example: `io://1234-5678-9012/12345678` -> `somfy-io-12345678`.
 */
export function nativeIdFor(deviceURL: string): string {
    const match = /^([a-z0-9]+):\/\/[^/]+\/(.+)$/i.exec(deviceURL);
    const raw = match ? `somfy-${match[1]}-${match[2]}` : `somfy-${deviceURL}`;
    const id = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+$/, "");
    return id.length <= 64 ? id : id.substring(0, 64);
}

/** Splits the "excluded devices" setting into normalised names. */
export function parseExcludedNames(value: string | undefined): string[] {
    return (value ?? "")
        .split(/[,;\n]/)
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0);
}

export function isExcluded(device: TahomaDevice, excluded: readonly string[]): boolean {
    const label = (device.label ?? "").trim().toLowerCase();
    return excluded.includes(label) || excluded.includes(device.deviceURL.toLowerCase());
}
