import { Logger, errorMessage } from "../log";
import {
    Direction,
    ForcedMode,
    Movement,
    PairingId,
    ShutterInput,
    moveInfoValue,
    parseInputDatapoint,
    parsePercentage,
} from "./datapoints";

/** The part of the library's `RawChannel` the addon needs (allows fakes in tests). */
export interface RawChannelLike {
    on(event: "datapointChanged", listener: (id: number, value: string) => void): unknown;
    on(event: "sceneTriggered", listener: (scene: { pairingID: number; value: string }[]) => void): unknown;
    setOutputDatapoint(id: number, value: string): Promise<void>;
    triggerKeepAlive(): Promise<void>;
    setUnresponsive(): Promise<void>;
}

export type ShutterInputHandler = (input: ShutterInput) => void;

const FORCE_INFO_VALUE: Record<ForcedMode, string> = {
    off: "0",
    restore: "0",
    up: "2",
    down: "3",
};

/**
 * A virtual free@home blind actuator (device type `BlindActuator`).
 *
 * Inputs from free@home (push buttons, app, scenes, timers) are handed to the bound handler;
 * outputs are only written when their value changes.
 */
export class FahShutterDevice {
    private handler: ShutterInputHandler | undefined;
    private readonly outputs = new Map<number, string>();
    private available = true;

    constructor(
        readonly nativeId: string,
        readonly name: string,
        private readonly channel: RawChannelLike,
        private readonly log = new Logger(`fah/${nativeId}`),
    ) {
        channel.on("datapointChanged", (id, value) => this.onDatapoint(id, value));
        channel.on("sceneTriggered", (scene) => this.onScene(scene));
    }

    get isAvailable(): boolean {
        return this.available;
    }

    bind(handler: ShutterInputHandler): void {
        this.handler = handler;
    }

    unbind(): void {
        this.handler = undefined;
    }

    setPosition(position: number): void {
        this.writeOutput(PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE, String(Math.round(position)));
    }

    setMovement(movement: Movement, lastDirection: Direction): void {
        this.writeOutput(PairingId.AL_INFO_MOVE_UP_DOWN, moveInfoValue(movement, lastDirection));
    }

    setForce(mode: ForcedMode): void {
        this.writeOutput(PairingId.AL_INFO_FORCE, FORCE_INFO_VALUE[mode]);
    }

    /** Forgets the last written outputs so that the next values are sent in any case. */
    resetOutputs(): void {
        this.outputs.clear();
    }

    /** Marks the device as (un)reachable in free@home. */
    async setAvailable(available: boolean): Promise<void> {
        if (available === this.available)
            return;
        this.available = available;
        this.log.info(available ? "reachable" : "not reachable");
        try {
            if (available) {
                // Send all values again, free@home may show outdated ones.
                this.outputs.clear();
                await this.channel.triggerKeepAlive();
            } else {
                await this.channel.setUnresponsive();
            }
        } catch (error) {
            this.log.warn(`could not update reachability: ${errorMessage(error)}`);
        }
    }

    /** Sends the regular life sign (renews the time-to-live of the virtual device). */
    async keepAlive(): Promise<void> {
        if (!this.available)
            return;
        try {
            await this.channel.triggerKeepAlive();
        } catch (error) {
            this.log.warn(`keep-alive failed: ${errorMessage(error)}`);
        }
    }

    private writeOutput(id: number, value: string): void {
        if (this.outputs.get(id) === value)
            return;
        this.outputs.set(id, value);
        this.channel.setOutputDatapoint(id, value).catch((error) => {
            this.outputs.delete(id);
            this.log.warn(`could not set datapoint 0x${id.toString(16)}=${value}: ${errorMessage(error)}`);
        });
    }

    private onDatapoint(id: number, value: string): void {
        const input = parseInputDatapoint(id, value);
        this.log.debug(`input 0x${id.toString(16)}=${value}${input ? "" : " (ignored)"}`);
        if (input)
            this.dispatch(input);
    }

    private onScene(scene: { pairingID: number; value: string }[]): void {
        for (const datapoint of scene) {
            if (datapoint.pairingID !== PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE)
                continue;
            const position = parsePercentage(datapoint.value);
            if (position !== undefined)
                this.dispatch({ type: "position", position, source: "scene" });
        }
    }

    private dispatch(input: ShutterInput): void {
        if (!this.handler) {
            this.log.debug("no connection to the TaHoma, input ignored");
            return;
        }
        try {
            this.handler(input);
        } catch (error) {
            this.log.error(`error while handling input: ${errorMessage(error)}`, error);
        }
    }
}
