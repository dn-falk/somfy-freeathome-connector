import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { App } from "../src/app";
import { Bridge, BridgeSettings } from "../src/bridge/bridge";
import { PairingId } from "../src/fah/datapoints";
import { FahDeviceRegistry } from "../src/fah/registry";
import { Logger } from "../src/log";
import { AddonStatus } from "../src/status";
import { FakeChannel, FakeRegistry, waitFor } from "./support/fakes";
import { TahomaSimulator } from "./support/tahomaSimulator";

Logger.silent = true;

function configuration(connection: Record<string, unknown>, behaviour: Record<string, unknown> = {}) {
    return { connection: { items: connection }, behaviour: { items: behaviour }, advanced: { items: { pollInterval: 1 } } };
}

describe("App", () => {
    let simulator: TahomaSimulator | undefined;
    let app: App | undefined;

    afterEach(async () => {
        await app?.shutdown();
        app = undefined;
        await simulator?.close();
        simulator = undefined;
    });

    function createApp(registry: FakeRegistry, statuses: AddonStatus[], bridges: BridgeSettings[] = []) {
        return new App({
            registry,
            insecureHttp: true,
            publishStatus: (status) => statuses.push(status),
            createBridge: (settings, devices) => {
                bridges.push(settings);
                return new Bridge(settings, { devices, tickIntervalMs: 20, retryDelaysMs: [20] });
            },
        });
    }

    it("asks for configuration and marks existing devices unreachable", async () => {
        const registry = new FakeRegistry();
        await registry.getOrCreate("somfy-io-1", "A");
        const statuses: AddonStatus[] = [];
        app = createApp(registry, statuses);

        await app.applyConfiguration("");
        assert.equal(app.getStatus().state, "configurationNeeded");
        assert.equal(registry.channel("somfy-io-1").unresponsiveCalls, 1);
    });

    it("connects with a valid configuration and restarts only on changes", async () => {
        simulator = new TahomaSimulator({ shutters: [{ id: "1", label: "A", position: 0 }] });
        const port = await simulator.listen();
        const registry = new FakeRegistry();
        const statuses: AddonStatus[] = [];
        const bridges: BridgeSettings[] = [];
        app = createApp(registry, statuses, bridges);

        const config = configuration({ host: "127.0.0.1", port, token: simulator.token }, { shortPressIdle: "move" });
        await app.applyConfiguration(config);
        assert.equal(bridges.length, 1);
        assert.equal(bridges[0].shortPressIdle, "move");
        assert.equal(bridges[0].tahoma.insecureHttp, true);
        await waitFor(() => app?.getStatus().state === "online", 3_000, "online");
        assert.deepEqual(app.getStatus(), { state: "online", shutterCount: 1, protocolVersion: "2026.3.4-12" });

        await app.applyConfiguration(JSON.parse(JSON.stringify(config)));
        assert.equal(bridges.length, 1, "same configuration does not restart the connection");

        registry.channel("somfy-io-1").input(PairingId.AL_STOP_STEP_UP_DOWN, "1");
        await waitFor(() => simulator?.commandsSent().length === 1, 1_000, "command");
        assert.equal(simulator.commandsSent()[0].name, "close");

        await app.applyConfiguration(configuration({ host: "127.0.0.1", port, token: "wrong" }));
        assert.equal(bridges.length, 2);
        await waitFor(() => app?.getStatus().state === "offline", 3_000, "offline");
        const status = app.getStatus();
        assert.ok(status.state === "offline" && status.authError);
        assert.ok(statuses.some((entry) => entry.state === "connecting"));
    });
});

describe("FahDeviceRegistry and FahShutterDevice", () => {
    it("creates each device once, writes only changed outputs and handles reachability", async () => {
        const channels: FakeChannel[] = [];
        let failNext = true;
        const registry = new FahDeviceRegistry({
            createShutter: async () => {
                if (failNext) {
                    failNext = false;
                    throw new Error("SysAP busy");
                }
                const channel = new FakeChannel();
                channels.push(channel);
                return channel;
            },
        });

        await assert.rejects(registry.getOrCreate("somfy-io-1", "A"), /SysAP busy/);
        const device = await registry.getOrCreate("somfy-io-1", "A");
        assert.equal(await registry.getOrCreate("somfy-io-1", "A"), device);
        assert.equal(channels.length, 1);
        const channel = channels[0];

        device.setPosition(40);
        device.setPosition(40);
        device.setMovement("down");
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(channel.writes, [
            { id: PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE, value: "40" },
            { id: PairingId.AL_INFO_MOVE_UP_DOWN, value: "3" },
        ]);

        await registry.keepAliveAll();
        assert.equal(channel.keepAlives, 1);

        await registry.setAllAvailable(false);
        assert.equal(channel.unresponsiveCalls, 1);
        await registry.keepAliveAll();
        assert.equal(channel.keepAlives, 1, "no keep-alive while unreachable");

        await registry.setAllAvailable(true);
        assert.equal(channel.keepAlives, 2);
        device.setPosition(40);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(channel.writes.length, 3, "outputs are sent again after becoming reachable");
    });

    it("forwards inputs to the bound handler only", async () => {
        const registry = new FakeRegistry();
        const device = await registry.getOrCreate("somfy-io-1", "A");
        const inputs: unknown[] = [];
        registry.channel("somfy-io-1").input(PairingId.AL_MOVE_UP_DOWN, "1");
        device.bind((input) => inputs.push(input));
        registry.channel("somfy-io-1").input(PairingId.AL_MOVE_UP_DOWN, "0");
        registry.channel("somfy-io-1").input(0x0001, "1");
        registry.channel("somfy-io-1").scene([
            { pairingID: PairingId.AL_INFO_MOVE_UP_DOWN, value: "0" },
            { pairingID: PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE, value: "25" },
        ]);
        device.unbind();
        registry.channel("somfy-io-1").input(PairingId.AL_MOVE_UP_DOWN, "1");
        assert.deepEqual(inputs, [
            { type: "move", direction: "up" },
            { type: "position", position: 25, source: "scene" },
        ]);
    });
});
