/**
 * Pairing IDs of the free@home blind actuator that the addon uses. The values are the same as
 * in `PairingIds` of `@busch-jaeger/free-at-home` (checked by a unit test); they are repeated
 * here so the control logic can be tested without the library.
 */
export const PairingId = {
    /** Input: move up ("0") or down ("1"), sent on a long press. */
    AL_MOVE_UP_DOWN: 0x0020,
    /** Input: stop, or step up ("0") / down ("1"), sent on a short press. */
    AL_STOP_STEP_UP_DOWN: 0x0021,
    /** Input: target position 0 (open) … 100 (closed). */
    AL_SET_ABSOLUTE_POSITION_BLINDS_PERCENTAGE: 0x0023,
    /** Input: forced position (0 off, 1 back to old position and off, 2 forced up, 3 forced down). */
    AL_FORCED_UP_DOWN: 0x0028,
    /** Output: cause of forced operation (0 = not forced). */
    AL_INFO_FORCE: 0x0101,
    /** Output: last moving direction and whether moving currently or not, see {@link moveInfoValue}. */
    AL_INFO_MOVE_UP_DOWN: 0x0120,
    /** Output (and input for scene playback): current position 0 (open) … 100 (closed). */
    AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE: 0x0121,
} as const;

export type Direction = "up" | "down";
export type Movement = "stopped" | Direction;
export type ForcedMode = "off" | "restore" | "up" | "down";

/**
 * Value of `AL_INFO_MOVE_UP_DOWN`, which indicates the last moving direction and whether the
 * shutter is moving: 0 stopped after moving up, 1 stopped after moving down, 2 moving up,
 * 3 moving down.
 */
export function moveInfoValue(movement: Movement, lastDirection: Direction): string {
    switch (movement) {
        case "up":
            return "2";
        case "down":
            return "3";
        case "stopped":
            return lastDirection === "down" ? "1" : "0";
    }
}

export const FORCED_MODE_BY_VALUE: Record<string, ForcedMode> = {
    "0": "off",
    "1": "restore",
    "2": "up",
    "3": "down",
};

/** Commands from free@home for one roller shutter. */
export type ShutterInput =
    | { type: "move"; direction: Direction }
    | { type: "stopStep"; direction: Direction }
    | { type: "position"; position: number; source: "setpoint" | "scene" }
    | { type: "forced"; mode: ForcedMode };

export function parsePercentage(value: string): number | undefined {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number))
        return undefined;
    return Math.min(100, Math.max(0, Math.round(number)));
}

/** Translates a changed input datapoint of the virtual actuator into a {@link ShutterInput}. */
export function parseInputDatapoint(pairingId: number, value: string): ShutterInput | undefined {
    switch (pairingId) {
        case PairingId.AL_MOVE_UP_DOWN:
            if (value === "0" || value === "1")
                return { type: "move", direction: value === "0" ? "up" : "down" };
            return undefined;
        case PairingId.AL_STOP_STEP_UP_DOWN:
            if (value === "0" || value === "1")
                return { type: "stopStep", direction: value === "0" ? "up" : "down" };
            return undefined;
        case PairingId.AL_SET_ABSOLUTE_POSITION_BLINDS_PERCENTAGE: {
            const position = parsePercentage(value);
            return position === undefined ? undefined : { type: "position", position, source: "setpoint" };
        }
        case PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE: {
            const position = parsePercentage(value);
            return position === undefined ? undefined : { type: "position", position, source: "scene" };
        }
        case PairingId.AL_FORCED_UP_DOWN: {
            const mode = FORCED_MODE_BY_VALUE[value];
            return mode ? { type: "forced", mode } : undefined;
        }
        default:
            return undefined;
    }
}
