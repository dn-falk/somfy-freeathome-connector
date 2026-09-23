import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Logger } from "../src/log";
import { TahomaApi } from "../src/tahoma/client";
import { TahomaError } from "../src/tahoma/errors";
import { GatewaySession, SetupInfo } from "../src/tahoma/session";
import { ApiVersion, TahomaAction, TahomaDevice, TahomaEvent } from "../src/tahoma/types";
import { delay, waitFor } from "./support/fakes";

Logger.silent = true;

type Step = TahomaEvent[] | Error;

/** Scriptable API: fetch results are taken from `fetchSteps`, afterwards empty lists are returned. */
class ScriptedApi implements TahomaApi {
    calls: string[] = [];
    fetchSteps: Step[] = [];
    connectError: Error | undefined;
    devices: TahomaDevice[] = [];
    private listenerCount = 0;

    async getApiVersion(): Promise<ApiVersion> {
        this.calls.push("apiVersion");
        if (this.connectError)
            throw this.connectError;
        return { protocolVersion: "1.2.3" };
    }

    async getDevices(): Promise<TahomaDevice[]> {
        this.calls.push("devices");
        return this.devices;
    }

    async execute(_actions: TahomaAction[], _label: string): Promise<string> {
        return "exec";
    }

    async registerEventListener(): Promise<string> {
        this.calls.push("register");
        return `listener-${++this.listenerCount}`;
    }

    async fetchEvents(listenerId: string): Promise<TahomaEvent[]> {
        this.calls.push(`fetch:${listenerId}`);
        const step = this.fetchSteps.shift();
        if (step instanceof Error)
            throw step;
        return step ?? [];
    }

    async unregisterEventListener(listenerId: string): Promise<void> {
        this.calls.push(`unregister:${listenerId}`);
    }

    warmUp(): void {
        this.calls.push("warmUp");
    }

    close(): void {}

    count(prefix: string): number {
        return this.calls.filter((call) => call.startsWith(prefix)).length;
    }
}

describe("GatewaySession", () => {
    let session: GatewaySession | undefined;

    afterEach(async () => {
        await session?.stop();
        session = undefined;
    });

    function start(api: ScriptedApi, idleIntervalMs = 20) {
        session = new GatewaySession(api, { idleIntervalMs, activeIntervalMs: 10, retryDelaysMs: [20, 40], authRetryDelayMs: 50 });
        const setups: SetupInfo[] = [];
        const events: TahomaEvent[][] = [];
        const offline: Error[] = [];
        session.on("setup", (info) => setups.push(info));
        session.on("events", (list) => events.push(list));
        session.on("offline", (error) => offline.push(error));
        session.start();
        return { session, setups, events, offline };
    }

    it("connects, reports the devices and forwards events", async () => {
        const api = new ScriptedApi();
        api.devices = [{ deviceURL: "io://x/1", label: "A" }];
        api.fetchSteps = [[], [{ name: "DeviceStateChangedEvent", deviceURL: "io://x/1" }]];
        const { setups, events, session: s } = start(api);

        await waitFor(() => events.length === 1, 2_000, "events");
        assert.deepEqual(api.calls.slice(0, 4), ["apiVersion", "register", "devices", "warmUp"]);
        assert.equal(setups.length, 1);
        assert.equal(setups[0].protocolVersion, "1.2.3");
        assert.equal(setups[0].devices.length, 1);
        assert.equal(events[0][0].deviceURL, "io://x/1");
        assert.equal(s.state, "online");
    });

    it("registers a new listener when the old one expired", async () => {
        const api = new ScriptedApi();
        api.fetchSteps = [new TahomaError("Invalid event listener id", "invalidListener", 400, "UNSPECIFIED_ERROR")];
        const { setups, offline } = start(api);

        await waitFor(() => setups.length === 2, 2_000, "second setup");
        assert.equal(api.count("register"), 2);
        assert.ok(api.calls.includes("fetch:listener-2"));
        assert.equal(offline.length, 0);
    });

    it("reports offline only after repeated failures and reconnects", async () => {
        const api = new ScriptedApi();
        const networkError = new TahomaError("ECONNREFUSED", "network");
        api.fetchSteps = [networkError];
        const { setups, offline, session: s } = start(api);

        await waitFor(() => setups.length === 2, 2_000, "reconnect after one failure");
        assert.equal(offline.length, 0, "a single failure is tolerated");

        api.connectError = networkError;
        api.fetchSteps = [networkError];
        await waitFor(() => offline.length === 1, 2_000, "offline");
        assert.equal(s.state, "offline");
        assert.equal(s.lastError, networkError);

        api.connectError = undefined;
        await waitFor(() => s.state === "online", 2_000, "back online");
        assert.equal(setups.length, 3);
    });

    it("reports a rejected token immediately", async () => {
        const api = new ScriptedApi();
        api.connectError = new TahomaError("HTTP 401", "auth", 401);
        const { offline, session: s } = start(api);
        await waitFor(() => offline.length === 1, 2_000, "offline");
        assert.equal(s.state, "offline");
    });

    it("polls faster while active and wakes up immediately", async () => {
        const api = new ScriptedApi();
        const { session: s } = start(api, 60_000);
        await waitFor(() => api.count("fetch") === 1, 2_000, "first fetch");
        await delay(50);
        assert.equal(api.count("fetch"), 1, "idle: next fetch much later");

        s.setActive(true);
        await waitFor(() => api.count("fetch") >= 4, 2_000, "fast polling");
        s.setActive(false);
    });

    it("reads the devices again on request", async () => {
        const api = new ScriptedApi();
        const { setups, session: s } = start(api, 60_000);
        await waitFor(() => setups.length === 1, 2_000, "setup");
        s.requestResync();
        await waitFor(() => setups.length === 2, 2_000, "resync");
        assert.equal(api.count("register"), 1);
        assert.equal(api.count("devices"), 2);
    });

    it("unregisters the listener when stopped", async () => {
        const api = new ScriptedApi();
        const { setups, session: s } = start(api, 60_000);
        await waitFor(() => setups.length === 1, 2_000, "setup");
        await s.stop();
        assert.ok(api.calls.includes("unregister:listener-1"));
        assert.equal(s.state, "stopped");
    });
});
