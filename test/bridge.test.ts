import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { Bridge, BridgeSettings } from "../src/bridge/bridge";
import { PairingId } from "../src/fah/datapoints";
import { Logger } from "../src/log";
import { FakeRegistry, delay, waitFor } from "./support/fakes";
import { SimulatedShutterOptions, SimulatorOptions, TahomaSimulator } from "./support/tahomaSimulator";

Logger.silent = true;

const MOVE = PairingId.AL_MOVE_UP_DOWN;
const STOP_STEP = PairingId.AL_STOP_STEP_UP_DOWN;
const SET_POSITION = PairingId.AL_SET_ABSOLUTE_POSITION_BLINDS_PERCENTAGE;
const INFO_MOVE = PairingId.AL_INFO_MOVE_UP_DOWN;
const CURRENT_POSITION = PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE;

describe("Bridge (end to end with simulated TaHoma)", () => {
    let simulator: TahomaSimulator;
    let bridge: Bridge | undefined;
    let registry: FakeRegistry;

    afterEach(async () => {
        mock.restoreAll();
        Logger.silent = true;
        Logger.debugEnabled = false;
        await bridge?.stop();
        bridge = undefined;
        await simulator.close();
    });

    async function setup(
        shutters: SimulatedShutterOptions[],
        overrides: Partial<BridgeSettings> = {},
        expectedDevices = shutters.length,
        simulatorOptions: Partial<SimulatorOptions> = {},
    ) {
        simulator = new TahomaSimulator({
            shutters,
            tickMs: 20,
            extraDevices: [{
                deviceURL: "io://1234-5678-9012/999",
                label: "Licht",
                definition: { uiClass: "Light", commands: [{ commandName: "on" }] },
            }],
            ...simulatorOptions,
        });
        const port = await simulator.listen();
        registry = new FakeRegistry();
        bridge = new Bridge({
            tahoma: { host: "127.0.0.1", port, token: simulator.token, verifyCertificate: true, insecureHttp: true },
            shortPressIdle: "stop",
            excluded: [],
            idlePollIntervalMs: 40,
            batchWindowMs: 0,
            ...overrides,
        }, { devices: registry, tickIntervalMs: 20, retryDelaysMs: [20, 40] });
        bridge.start();
        await waitFor(() => bridge?.status.state === "online" && registry.devices.size === expectedDevices, 3_000, "bridge online");
    }

    it("creates one free@home blind actuator per io roller shutter", async () => {
        await setup([
            { id: "11", label: "Wohnzimmer", position: 0 },
            { id: "12", label: "Küche", position: 100 },
        ]);
        assert.deepEqual([...registry.names.entries()], [
            ["somfy-io-11", "Wohnzimmer"],
            ["somfy-io-12", "Küche"],
        ]);
        await waitFor(() => registry.channel("somfy-io-12").outputs.get(CURRENT_POSITION) === "100", 1_000, "initial position");
        assert.equal(registry.channel("somfy-io-11").outputs.get(CURRENT_POSITION), "0");
        assert.equal(registry.channel("somfy-io-11").outputs.get(INFO_MOVE), "0");
        await waitFor(() => registry.channel("somfy-io-12").outputs.get(INFO_MOVE) === "1", 1_000, "closed shutter: last direction down");
        assert.equal(bridge?.status.shutterCount, 2);
    });

    it("skips excluded roller shutters", async () => {
        await setup([{ id: "11", label: "Wohnzimmer" }, { id: "12", label: "Bad" }], { excluded: ["bad"] }, 1);
        await delay(100);
        assert.deepEqual([...registry.names.keys()], ["somfy-io-11"]);
        assert.equal(bridge?.status.shutterCount, 1);
    });

    it("long press closes the shutter right away and reports the end position", async () => {
        await setup([{ id: "11", label: "Wohnzimmer", position: 0, travelMs: 400 }]);
        const channel = registry.channel("somfy-io-11");

        const pressed = Date.now();
        channel.input(MOVE, "1");
        assert.equal(channel.outputs.get(INFO_MOVE), "3", "movement is shown immediately");
        await waitFor(() => simulator.commandsSent().length === 1, 1_000, "command at the box");
        const latency = simulator.executions.length > 0
            ? simulator.requests.find((request) => request.path === "/exec/apply")!.at - pressed : Infinity;
        assert.ok(latency < 250, `command reached the box after ${latency} ms`);
        assert.deepEqual(simulator.commandsSent(), [{ deviceURL: simulator.deviceURL("11"), name: "close", parameters: undefined }]);

        await waitFor(() => channel.outputs.get(CURRENT_POSITION) === "100", 3_000, "end position");
        await waitFor(() => channel.outputs.get(INFO_MOVE) === "1", 3_000, "stopped after moving down");
        assert.equal(simulator.position("11"), 100);
    });

    it("does not query events while a command from idle is on its way to the box", async () => {
        // The box answers a command later while it handles an event query at the same time.
        await setup([{ id: "11", label: "Wohnzimmer", position: 0 }], { idlePollIntervalMs: 5_000, batchWindowMs: 10 });
        await delay(100);
        const pressed = Date.now();
        registry.channel("somfy-io-11").input(MOVE, "1");
        await waitFor(() => simulator.executions.length === 1, 1_000, "command at the box");
        const apply = simulator.requests.find((request) => request.path === "/exec/apply")!;
        await delay(100);
        const fetches = simulator.requests.filter((request) => request.path.endsWith("/fetch")
            && request.at >= pressed && request.at <= apply.at + 100);
        assert.deepEqual(fetches, []);
        await waitFor(() => registry.channel("somfy-io-11").outputs.get(CURRENT_POSITION) === "100", 5_000, "feedback follows");
    });

    it("short press stops the shutter in between", async () => {
        await setup([{ id: "11", label: "Wohnzimmer", position: 0, travelMs: 1_000 }]);
        const channel = registry.channel("somfy-io-11");

        channel.input(MOVE, "1");
        await delay(300);
        channel.input(STOP_STEP, "1");
        await waitFor(() => simulator.commandsSent().some((command) => command.name === "stop"), 1_000, "stop at the box");
        await waitFor(() => !simulator.isMoving("11"), 1_000, "shutter stopped");

        const position = simulator.position("11");
        assert.ok(position > 5 && position < 95, `stopped in between (${position})`);
        await waitFor(() => channel.outputs.get(CURRENT_POSITION) === String(position), 2_000, "position reported");
        assert.equal(channel.outputs.get(INFO_MOVE), "1", "stopped after moving down");
    });

    it("keeps asking the box every second until it confirms a stop", async () => {
        // The real box reports the end of a stop only after a second or more. The position must
        // not wait for the (long) idle interval.
        await setup([{ id: "11", label: "Wohnzimmer", position: 0, travelMs: 4_000 }],
            { idlePollIntervalMs: 6_000 }, 1, { stopDelayMs: 1_200 });
        const channel = registry.channel("somfy-io-11");

        channel.input(MOVE, "1");
        await delay(400);
        const stopped = Date.now();
        channel.input(STOP_STEP, "1");
        await waitFor(() => !simulator.isMoving("11"), 3_000, "shutter stopped");
        const position = simulator.position("11");
        assert.ok(position > 5 && position < 95, `stopped in between (${position})`);

        await waitFor(() => channel.outputs.get(CURRENT_POSITION) === String(position), 4_000, "position reported");
        const elapsed = Date.now() - stopped;
        assert.ok(elapsed < 3_500, `position reported ${elapsed} ms after the stop`);

        // Back to the idle interval once the stop is confirmed.
        const fetches = () => simulator.requests.filter((request) => request.path.endsWith("/fetch")).length;
        const before = fetches();
        await delay(2_500);
        assert.ok(fetches() - before <= 1, `${fetches() - before} fetches while idle`);
    });

    it("relates the events of the box to the commands in the debug log", async () => {
        await setup([{ id: "11", label: "Wohnzimmer", position: 0, travelMs: 1_000 }]);
        const lines: string[] = [];
        mock.method(console, "log", (line: unknown) => lines.push(String(line)));
        Logger.silent = false;
        Logger.debugEnabled = true;
        const channel = registry.channel("somfy-io-11");

        channel.input(MOVE, "1");
        await delay(200);
        channel.input(STOP_STEP, "1");
        await waitFor(() => lines.some((line) => /ExecutionStateChangedEvent \S+ \S+ -> COMPLETED .*s after stop "Wohnzimmer"/.test(line)),
            2_000, "stop execution in the log");
        await waitFor(() => lines.some((line) => line.includes("DeviceStateChangedEvent \"Wohnzimmer\"")
            && line.includes("core:MovingState=false") && /\[box \d\d:\d\d:\d\d\.\d{3}, [\d.]+ s after stop\]/.test(line)),
            2_000, "end of the movement in the log");
        assert.ok(lines.some((line) => /ExecutionStateChangedEvent \S+ IN_PROGRESS -> FAILED \(CMDCANCELLED\) .*s after close "Wohnzimmer"/.test(line)),
            "cancelled close command");
        assert.ok(!lines.some((line) => line.includes("/fetch")), "routine event queries are not logged");
    });

    it("stops a movement started with a Somfy remote", async () => {
        await setup([{ id: "11", label: "Wohnzimmer", position: 100, travelMs: 2_000 }]);
        const channel = registry.channel("somfy-io-11");

        simulator.moveExternally("11", 0);
        await waitFor(() => channel.outputs.get(INFO_MOVE) === "2", 2_000, "external movement up is shown");
        channel.input(STOP_STEP, "0");
        await waitFor(() => !simulator.isMoving("11"), 1_000, "stopped");
        assert.deepEqual(simulator.commandsSent().map((command) => command.name), ["stop"]);
    });

    it("sends a push button linked to several shutters as one request", async () => {
        await setup([
            { id: "11", label: "A", position: 0 },
            { id: "12", label: "B", position: 0 },
            { id: "13", label: "C", position: 0 },
        ]);
        registry.channel("somfy-io-11").input(MOVE, "1");
        registry.channel("somfy-io-12").input(MOVE, "1");
        registry.channel("somfy-io-13").input(SET_POSITION, "40");
        await waitFor(() => simulator.executions.length > 0, 1_000, "execution");
        await delay(50);
        assert.equal(simulator.executions.length, 1);
        assert.deepEqual(simulator.executions[0].actions.map((action) => action.commands[0].name), ["close", "close", "setClosure"]);
    });

    it("plays back scenes", async () => {
        await setup([{ id: "11", label: "A", position: 0 }]);
        registry.channel("somfy-io-11").scene([{ pairingID: CURRENT_POSITION, value: "70" }]);
        await waitFor(() => simulator.commandsSent().length === 1, 1_000, "scene command");
        assert.deepEqual(simulator.commandsSent()[0].parameters, [70]);
    });

    it("shows unreachable shutters as unresponsive", async () => {
        await setup([{ id: "11", label: "A" }]);
        const channel = registry.channel("somfy-io-11");
        simulator.setAvailable("11", false);
        await waitFor(() => channel.unresponsiveCalls === 1, 2_000, "unresponsive");
        simulator.setAvailable("11", true);
        await waitFor(() => channel.keepAlives >= 1, 2_000, "responsive again");
    });

    it("marks all shutters unresponsive while the box is offline and recovers", async () => {
        await setup([{ id: "11", label: "A" }]);
        const channel = registry.channel("somfy-io-11");

        simulator.unreachable = true;
        await waitFor(() => bridge?.status.state === "offline", 3_000, "offline");
        await waitFor(() => channel.unresponsiveCalls === 1, 1_000, "unresponsive");

        simulator.unreachable = false;
        await waitFor(() => bridge?.status.state === "online", 3_000, "online again");
        await waitFor(() => channel.keepAlives >= 1, 1_000, "responsive again");
    });

    it("re-registers after a reboot of the box", async () => {
        await setup([{ id: "11", label: "A", position: 0 }]);
        const registrations = () => simulator.requests.filter((request) => request.path === "/events/register").length;
        assert.equal(registrations(), 1);
        simulator.dropListeners();
        await waitFor(() => registrations() === 2, 2_000, "new listener");

        registry.channel("somfy-io-11").input(MOVE, "1");
        await waitFor(() => registry.channel("somfy-io-11").outputs.get(CURRENT_POSITION) === "100", 5_000, "events after re-registration");
    });

    it("ignores free@home inputs after stop", async () => {
        await setup([{ id: "11", label: "A" }]);
        await bridge?.stop();
        bridge = undefined;
        registry.channel("somfy-io-11").input(MOVE, "1");
        await delay(50);
        assert.equal(simulator.commandsSent().length, 0);
    });
});
