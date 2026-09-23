import { Bridge, BridgeSettings, ShutterDeviceProvider } from "./bridge/bridge";
import { ConfigResult, Settings, parseConfiguration } from "./config";
import { Logger, errorMessage } from "./log";
import { AddonStatus, fromBridgeStatus } from "./status";

export interface DeviceRegistry extends ShutterDeviceProvider {
    setAllAvailable(available: boolean): Promise<void>;
    resetOutputs(): Promise<void>;
}

export interface AppDependencies {
    registry: DeviceRegistry;
    publishStatus(status: AddonStatus): void;
    createBridge?(settings: BridgeSettings, registry: DeviceRegistry): Bridge;
    /** Use plain HTTP towards the TaHoma (development with the mock server only). */
    insecureHttp?: boolean;
}

export function toBridgeSettings(settings: Settings, insecureHttp = false): BridgeSettings {
    return {
        tahoma: {
            host: settings.host,
            port: settings.port,
            token: settings.token,
            gatewayPin: settings.gatewayPin,
            verifyCertificate: settings.verifyCertificate,
            insecureHttp,
        },
        shortPressIdle: settings.shortPressIdle,
        excluded: settings.excluded,
        idlePollIntervalMs: settings.pollIntervalMs,
        batchWindowMs: settings.batchWindowMs,
    };
}

/**
 * Reacts to configuration changes: (re)starts the bridge with the new settings and keeps the
 * status shown in the addon settings up to date.
 */
export class App {
    private bridge: Bridge | undefined;
    private appliedKey: string | undefined;
    private chain: Promise<void> = Promise.resolve();
    private status: AddonStatus = { state: "starting" };
    private readonly log = new Logger("app");

    constructor(private readonly deps: AppDependencies) {}

    getStatus(): AddonStatus {
        return this.status;
    }

    /** Applies a configuration; calls are processed one after another. */
    applyConfiguration(configuration: unknown): Promise<void> {
        this.chain = this.chain
            .then(() => this.apply(parseConfiguration(configuration)))
            .catch((error) => this.log.error(`could not apply configuration: ${errorMessage(error)}`, error));
        return this.chain;
    }

    resync(): void {
        if (this.bridge) {
            this.log.info("reloading roller shutters from the TaHoma");
            this.bridge.resync();
        }
    }

    /** The connection to the System Access Point was (re)established: send all states again. */
    async republish(): Promise<void> {
        await this.deps.registry.resetOutputs();
        this.bridge?.republish();
    }

    async shutdown(): Promise<void> {
        await this.chain;
        await this.stopBridge();
    }

    private async apply(result: ConfigResult): Promise<void> {
        Logger.debugEnabled = result.ok && result.settings.debug;
        const key = JSON.stringify(result);
        if (key === this.appliedKey)
            return;
        this.appliedKey = key;

        await this.stopBridge();
        if (!result.ok) {
            this.log.warn(`configuration incomplete: ${result.problems.map((problem) => problem.en).join(", ")}`);
            await this.deps.registry.setAllAvailable(false);
            this.setStatus({ state: "configurationNeeded", problems: result.problems });
            return;
        }

        const settings = toBridgeSettings(result.settings, this.deps.insecureHttp);
        const bridge = this.deps.createBridge
            ? this.deps.createBridge(settings, this.deps.registry)
            : new Bridge(settings, { devices: this.deps.registry });
        bridge.on("status", (status) => {
            if (bridge === this.bridge)
                this.setStatus(fromBridgeStatus(status));
        });
        this.bridge = bridge;
        this.setStatus({ state: "connecting" });
        bridge.start();
    }

    private async stopBridge(): Promise<void> {
        const bridge = this.bridge;
        this.bridge = undefined;
        if (bridge)
            await bridge.stop();
    }

    private setStatus(status: AddonStatus): void {
        this.status = status;
        this.deps.publishStatus(status);
    }
}
