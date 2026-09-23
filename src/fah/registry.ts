import { Logger, errorMessage } from "../log";
import { FahShutterDevice, RawChannelLike } from "./shutterDevice";

export interface VirtualShutterFactory {
    /** Creates (or reuses) the virtual free@home blind actuator with the given id. */
    createShutter(nativeId: string, name: string): Promise<RawChannelLike>;
}

/**
 * Every life sign sets the time-to-live of the virtual device (30 min with free@home library
 * 0.37); without a new one the System Access Point shows the device as unreachable.
 */
export const KEEP_ALIVE_INTERVAL_MS = 10 * 60_000;

/**
 * Owns the virtual free@home devices for the whole lifetime of the addon.
 *
 * Devices are created only once, even if the configuration changes and the connection to the
 * TaHoma is rebuilt: every creation would register another listener on the library's channel.
 */
export class FahDeviceRegistry {
    private readonly devices = new Map<string, Promise<FahShutterDevice>>();
    private keepAliveTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly factory: VirtualShutterFactory,
        private readonly log = new Logger("fah"),
        private readonly keepAliveIntervalMs = KEEP_ALIVE_INTERVAL_MS,
    ) {}

    getOrCreate(nativeId: string, name: string): Promise<FahShutterDevice> {
        let device = this.devices.get(nativeId);
        if (!device) {
            this.log.info(`creating free@home roller shutter "${name}" (${nativeId})`);
            device = this.factory.createShutter(nativeId, name)
                .then((channel) => new FahShutterDevice(nativeId, name, channel, this.log.child(nativeId)));
            // Allow a new attempt if the creation failed.
            device.catch((error) => {
                this.log.error(`could not create free@home device ${nativeId}: ${errorMessage(error)}`);
                this.devices.delete(nativeId);
            });
            this.devices.set(nativeId, device);
        }
        return device;
    }

    startKeepAlive(): void {
        if (this.keepAliveTimer)
            return;
        this.keepAliveTimer = setInterval(() => void this.keepAliveAll(), this.keepAliveIntervalMs);
    }

    stopKeepAlive(): void {
        if (this.keepAliveTimer)
            clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = undefined;
    }

    async keepAliveAll(): Promise<void> {
        await Promise.all((await this.createdDevices()).map((device) => device.keepAlive()));
    }

    /** Marks all devices as (un)reachable, e.g. while the addon is not configured. */
    async setAllAvailable(available: boolean): Promise<void> {
        await Promise.all((await this.createdDevices()).map((device) => device.setAvailable(available)));
    }

    /** Forgets the last written outputs so that all values are sent again. */
    async resetOutputs(): Promise<void> {
        for (const device of await this.createdDevices())
            device.resetOutputs();
    }

    async createdDevices(): Promise<FahShutterDevice[]> {
        const results = await Promise.allSettled(this.devices.values());
        return results
            .filter((result): result is PromiseFulfilledResult<FahShutterDevice> => result.status === "fulfilled")
            .map((result) => result.value);
    }
}
