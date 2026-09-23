import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { PairingId } from "../src/fah/datapoints";
import { FakeSysap } from "./support/fakeSysap";
import { TahomaSimulator } from "./support/tahomaSimulator";
import { waitFor } from "./support/fakes";

// ADDON_ROOT allows running this test against an unpacked addon archive (.tar).
const ROOT = process.env.ADDON_ROOT ?? resolve(__dirname, "..", "..");
const MAIN = process.env.ADDON_ROOT ? join(ROOT, "build", "main.js") : join(ROOT, ".test-build", "src", "main.js");
const ADDON_ID = (JSON.parse(readFileSync(join(ROOT, "free-at-home-metadata.json"), "utf8")) as { id: string }).id;

/**
 * Runs the compiled addon (with the real @busch-jaeger/free-at-home library) as separate
 * process against a fake System Access Point and the TaHoma simulator.
 */
describe("addon process (real free@home library, fake System Access Point)", () => {
    let sysap: FakeSysap;
    let simulator: TahomaSimulator;
    let addon: ChildProcess;
    let output = "";
    let exitCode: number | null | undefined;

    const configuration = (token: string) => ({
        connection: { items: { host: "127.0.0.1", port: simulatorPort, token } },
        behaviour: { items: { shortPressIdle: "stop" } },
        advanced: { items: { pollInterval: 1, batchWindow: 0, debug: true } },
    });
    let simulatorPort = 0;

    before(async () => {
        simulator = new TahomaSimulator({
            tickMs: 20,
            shutters: [
                { id: "11", label: "Wohnzimmer", position: 0, travelMs: 600 },
                { id: "12", label: "Küche", position: 100, travelMs: 600 },
            ],
        });
        simulatorPort = await simulator.listen();
        sysap = new FakeSysap(ADDON_ID);
        const baseUrl = await sysap.listen();
        sysap.setConfiguration(configuration(simulator.token));

        addon = spawn(process.execPath, [MAIN], {
            cwd: ROOT,
            env: {
                ...process.env,
                FREEATHOME_BASE_URL: baseUrl,
                FREEATHOME_API_USERNAME: "installer",
                FREEATHOME_API_PASSWORD: "12345",
                TAHOMA_INSECURE_HTTP: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        addon.stdout?.on("data", (chunk: Buffer) => output += chunk.toString());
        addon.stderr?.on("data", (chunk: Buffer) => output += chunk.toString());
        addon.on("exit", (code) => exitCode = code);
    });

    after(async () => {
        if (exitCode === undefined)
            addon.kill("SIGKILL");
        await sysap.close();
        await simulator.close();
    });

    const check = async (condition: () => boolean, what: string, timeoutMs = 8_000) => {
        try {
            await waitFor(condition, timeoutMs, what);
        } catch (error) {
            const devices = [...sysap.devices.values()].map((device) => `${device.nativeId}: ttl ${device.ttl}`).join(", ");
            throw new Error(`${(error as Error).message}\n--- devices: ${devices}\n--- addon output ---\n${output}`);
        }
    };

    it("creates a virtual blind actuator per roller shutter", async () => {
        await check(() => sysap.devices.size === 2, "virtual devices");
        assert.equal(sysap.device("somfy-io-11").type, "BlindActuator");
        assert.equal(sysap.device("somfy-io-11").displayName, "Wohnzimmer");
        assert.equal(sysap.device("somfy-io-12").displayName, "Küche");
        await check(() => sysap.output("somfy-io-12", PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE) === "100", "initial position");
        await check(() => sysap.applicationStates.some((state) =>
            (state as { state?: { id?: string } }).state?.id === "ok"
            && /Verbunden, 2 Rollläden/.test((state as { state: { text: string } }).state.text)), "application state");
    });

    it("moves the shutter when the free@home push button is pressed", async () => {
        sysap.input("somfy-io-11", PairingId.AL_MOVE_UP_DOWN, "1");
        await check(() => simulator.commandsSent().some((command) => command.name === "close"), "close at the TaHoma");
        await check(() => sysap.output("somfy-io-11", PairingId.AL_INFO_MOVE_UP_DOWN) === "3", "moving down shown");
        await check(() => sysap.output("somfy-io-11", PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE) === "100", "end position");
        await check(() => sysap.output("somfy-io-11", PairingId.AL_INFO_MOVE_UP_DOWN) === "0", "stopped");
    });

    it("answers the status RPC of the addon settings", async () => {
        await check(() => sysap.rpcConnected, "RPC websocket");
        const result = await sysap.rpc("getParameterConfig", { parameter: "status", group: "connection" }) as Record<string, string>;
        assert.equal(result["name@de"], "Verbunden, 2 Rollläden");
        assert.equal(result.type, "text");
    });

    it("reconnects with a changed configuration", async () => {
        sysap.setConfiguration(configuration("wrong-token"));
        await check(() => sysap.applicationStates.some((state) =>
            (state as { state?: { id?: string } }).state?.id === "error"), "error state for the wrong token");
        const result = await sysap.rpc("getParameterConfig", {}) as Record<string, string>;
        assert.match(result["name@de"], /Token wird von der TaHoma Switch abgelehnt/);
        assert.equal(result.type, "error");
        await check(() => sysap.device("somfy-io-11").ttl === "0", "devices shown as unreachable");
    });

    it("shuts down cleanly on SIGTERM", async () => {
        sysap.setConfiguration(configuration(simulator.token));
        await check(() => sysap.device("somfy-io-11").ttl !== "0", "reachable again");
        addon.kill("SIGTERM");
        await check(() => exitCode !== undefined, "process exit", 8_000);
        assert.equal(exitCode, 0);
        assert.equal(sysap.device("somfy-io-11").ttl, "0");
        assert.equal(sysap.device("somfy-io-12").ttl, "0");
        assert.doesNotMatch(output, /unhandled rejection/i);
    });
});
