import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TahomaError, apiError, isStaleSocketError } from "../src/tahoma/errors";
import { applicationState, describeStatus, fromBridgeStatus, statusParameter } from "../src/status";

describe("API errors", () => {
    it("classifies errors of the local API", () => {
        assert.equal(apiError(401, JSON.stringify({ error: "Not authenticated.", errorCode: "RESOURCE_ACCESS_DENIED" })).kind, "auth");
        assert.equal(apiError(400, JSON.stringify({ error: "\"No registered event listener.\"", errorCode: "UNSPECIFIED_ERROR" })).kind, "invalidListener");
        assert.equal(apiError(400, JSON.stringify({ error: "Invalid event listener id : abc", errorCode: "UNSPECIFIED_ERROR" })).kind, "invalidListener");
        const noDevice = apiError(400, JSON.stringify({ error: "No such device : \"io://x/1\"", errorCode: "NO_SUCH_DEVICE" }));
        assert.equal(noDevice.kind, "api");
        assert.equal(noDevice.errorCode, "NO_SUCH_DEVICE");
        assert.equal(apiError(500, "<html>").kind, "api");
    });

    it("retries only on sockets that were reused", () => {
        assert.equal(isStaleSocketError(new TahomaError("x", "network", undefined, undefined, "ECONNRESET", true)), true);
        assert.equal(isStaleSocketError(new TahomaError("socket hang up", "network", undefined, undefined, undefined, true)), true);
        assert.equal(isStaleSocketError(new TahomaError("x", "network", undefined, undefined, "ECONNRESET", false)), false);
        assert.equal(isStaleSocketError(new TahomaError("x", "network", undefined, undefined, "ECONNREFUSED", true)), false);
        assert.equal(isStaleSocketError(new Error("ECONNRESET")), false);
    });
});

describe("status", () => {
    it("describes the states in German and English", () => {
        assert.equal(describeStatus({ state: "online", shutterCount: 3 }).de, "Verbunden, 3 Rollläden");
        assert.match(describeStatus({ state: "offline", error: "timeout", authError: false }).de, /nicht erreichbar/);
        assert.match(describeStatus({ state: "offline", error: "HTTP 401", authError: true }).en, /Token rejected/);
        assert.match(describeStatus({ state: "configurationNeeded", problems: [{ en: "token is missing", de: "Token fehlt" }] }).de,
            /Konfiguration nötig: Token fehlt/);
    });

    it("maps the bridge status", () => {
        assert.deepEqual(fromBridgeStatus({ state: "online", shutterCount: 2, protocolVersion: "1" }),
            { state: "online", shutterCount: 2, protocolVersion: "1" });
        assert.deepEqual(fromBridgeStatus({ state: "offline", shutterCount: 2, error: new TahomaError("HTTP 401", "auth", 401) }),
            { state: "offline", error: "HTTP 401", authError: true });
        assert.deepEqual(fromBridgeStatus({ state: "connecting", shutterCount: 0 }), { state: "connecting" });
    });

    it("builds the status parameter and application state", () => {
        const offline = statusParameter({ state: "offline", error: "timeout", authError: false });
        assert.equal(offline.type, "error");
        assert.equal(statusParameter({ state: "online", shutterCount: 1 }).type, "text");
        assert.deepEqual(applicationState({ state: "configurationNeeded", problems: [] }),
            { state: { id: "configurationNeeded", text: "Konfiguration nötig: Einstellungen fehlen" } });
        assert.equal((applicationState({ state: "online", shutterCount: 1 }).state as { id: string }).id, "ok");
    });
});
