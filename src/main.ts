// Only the needed parts of the library are loaded: the package index also loads the serial port
// support (rewiremock, serialport), which costs several MB of the 64 MB an addon may use.
// The deep imports are safe because the library version is pinned in package.json.
import * as AddOn from "@busch-jaeger/free-at-home/lib/addon";
import { FreeAtHome } from "@busch-jaeger/free-at-home/lib/freeAtHome";
import { RpcWebsocket } from "@busch-jaeger/free-at-home/lib/rpcWebsocket";

import { App } from "./app";
import { FahDeviceRegistry } from "./fah/registry";
import { RawChannelLike } from "./fah/shutterDevice";
import { Logger, errorMessage } from "./log";
import { applicationState, statusParameter } from "./status";

const log = new Logger("main");
const SHUTDOWN_TIMEOUT_MS = 5_000;

function main(): void {
    const metaData = AddOn.readMetaData();
    log.info(`starting ${metaData.id} ${metaData.version}`);

    const freeAtHome = new FreeAtHome();
    const registry = new FahDeviceRegistry({
        createShutter: async (nativeId, name) =>
            await freeAtHome.createRawDevice(nativeId, name, "BlindActuator") as unknown as RawChannelLike,
    });
    registry.startKeepAlive();

    const addOn = new AddOn.AddOn(metaData.id);
    const app = new App({
        registry,
        insecureHttp: process.env.TAHOMA_INSECURE_HTTP === "1",
        publishStatus: (status) => {
            Promise.resolve(addOn.setApplicationState(applicationState(status) as unknown as AddOn.ApplicationState))
                .catch((error) => log.debug(`could not publish application state: ${errorMessage(error)}`));
        },
    });

    addOn.on("configurationChanged", (configuration) => {
        log.info("configuration received");
        void app.applyConfiguration(configuration);
    });
    addOn.on("event", (event) => {
        if (event.eventType === "buttonPressed" && event.parameter === "resync")
            app.resync();
    });
    addOn.connectToConfiguration();
    addOn.connectToEvents();

    // Status line in the addon settings (parameter "status", see free-at-home-metadata.json).
    const rpc = new RpcWebsocket(metaData.id);
    rpc.addMethod("getParameterConfig", () => statusParameter(app.getStatus()));

    // After a restart of the System Access Point: life sign and all values again.
    freeAtHome.on("open", () => {
        void registry.keepAliveAll();
        void app.republish();
    });

    let shuttingDown = false;
    const shutdown = (signal: string) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        log.info(`${signal} received, shutting down`);
        const cleanup = async () => {
            registry.stopKeepAlive();
            await app.shutdown();
            await freeAtHome.markAllDevicesAsUnresponsive();
        };
        const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
        Promise.race([cleanup(), timeout])
            .catch((error) => log.error(`error during shutdown: ${errorMessage(error)}`))
            .finally(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
    log.error(`unhandled rejection: ${errorMessage(reason)}`, reason);
});

main();
