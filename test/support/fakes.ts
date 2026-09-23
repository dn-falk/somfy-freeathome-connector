import { EventEmitter } from "node:events";

import { Clock, ShutterView } from "../../src/bridge/shutterController";
import { Direction, ForcedMode, Movement } from "../../src/fah/datapoints";
import { FahShutterDevice, RawChannelLike } from "../../src/fah/shutterDevice";

export class FakeClock implements Clock {
    constructor(public time = 1_000_000) {}

    now(): number {
        return this.time;
    }

    advance(ms: number): void {
        this.time += ms;
    }
}

/** Records what the controller writes towards free@home. */
export class RecordingView implements ShutterView {
    positions: number[] = [];
    movements: Movement[] = [];
    /** The last moving direction passed with each movement. */
    directions: Direction[] = [];
    forces: ForcedMode[] = [];

    setPosition(position: number): void {
        this.positions.push(position);
    }

    setMovement(movement: Movement, lastDirection: Direction): void {
        this.movements.push(movement);
        this.directions.push(lastDirection);
    }

    setForce(mode: ForcedMode): void {
        this.forces.push(mode);
    }

    get lastMovement(): Movement | undefined {
        return this.movements[this.movements.length - 1];
    }

    get lastDirection(): Direction | undefined {
        return this.directions[this.directions.length - 1];
    }

    get lastPosition(): number | undefined {
        return this.positions[this.positions.length - 1];
    }
}

/** Stands in for the library's RawChannel of a virtual free@home device. */
export class FakeChannel extends EventEmitter implements RawChannelLike {
    readonly outputs = new Map<number, string>();
    readonly writes: { id: number; value: string }[] = [];
    keepAlives = 0;
    unresponsiveCalls = 0;

    async setOutputDatapoint(id: number, value: string): Promise<void> {
        this.outputs.set(id, value);
        this.writes.push({ id, value });
    }

    async triggerKeepAlive(): Promise<void> {
        this.keepAlives++;
    }

    async setUnresponsive(): Promise<void> {
        this.unresponsiveCalls++;
    }

    /** Simulates free@home writing an input datapoint (push button, app, …). */
    input(pairingId: number, value: string): void {
        this.emit("datapointChanged", pairingId, value);
    }

    scene(datapoints: { pairingID: number; value: string }[]): void {
        this.emit("sceneTriggered", datapoints);
    }
}

/** Device registry backed by fake channels. */
export class FakeRegistry {
    readonly channels = new Map<string, FakeChannel>();
    readonly devices = new Map<string, FahShutterDevice>();
    readonly names = new Map<string, string>();

    async getOrCreate(nativeId: string, name: string): Promise<FahShutterDevice> {
        let device = this.devices.get(nativeId);
        if (!device) {
            const channel = new FakeChannel();
            device = new FahShutterDevice(nativeId, name, channel);
            this.channels.set(nativeId, channel);
            this.devices.set(nativeId, device);
            this.names.set(nativeId, name);
        }
        return device;
    }

    async createdDevices(): Promise<FahShutterDevice[]> {
        return [...this.devices.values()];
    }

    async setAllAvailable(available: boolean): Promise<void> {
        await Promise.all([...this.devices.values()].map((device) => device.setAvailable(available)));
    }

    async resetOutputs(): Promise<void> {
        for (const device of this.devices.values())
            device.resetOutputs();
    }

    channel(nativeId: string): FakeChannel {
        const channel = this.channels.get(nativeId);
        if (!channel)
            throw new Error(`no free@home device ${nativeId}`);
        return channel;
    }
}

export async function waitFor(condition: () => boolean, timeoutMs = 3_000, what = "condition"): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs)
            throw new Error(`timeout waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
