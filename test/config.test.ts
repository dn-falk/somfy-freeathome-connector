import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfiguration, parseHost } from "../src/config";

function configuration(connection: Record<string, unknown>, behaviour: Record<string, unknown> = {}, advanced: Record<string, unknown> = {}) {
    return {
        connection: { items: connection },
        behaviour: { items: behaviour },
        advanced: { items: advanced },
    };
}

describe("configuration", () => {
    it("reports missing settings", () => {
        for (const input of [undefined, "", {}, configuration({})]) {
            const result = parseConfiguration(input);
            assert.equal(result.ok, false);
            if (!result.ok)
                assert.deepEqual(result.problems.map((problem) => problem.de), ["IP-Adresse der TaHoma Switch fehlt", "Token fehlt"]);
        }
    });

    it("applies defaults", () => {
        const result = parseConfiguration(configuration({ host: " 192.168.1.50 ", token: "secret" }));
        assert.ok(result.ok);
        assert.deepEqual(result.settings, {
            host: "192.168.1.50",
            port: 8443,
            token: "secret",
            gatewayPin: undefined,
            verifyCertificate: true,
            shortPressIdle: "stop",
            excluded: [],
            pollIntervalMs: 3000,
            batchWindowMs: 10,
            debug: false,
        });
    });

    it("reads all settings and clamps numbers", () => {
        const result = parseConfiguration(configuration(
            { host: "gateway-1234-5678-9012.local", port: "8444", token: "t", gatewayPin: "1234-5678-9012", verifyCertificate: false },
            { shortPressIdle: "my", excludedDevices: "Bad, Küche" },
            { pollInterval: 500, batchWindow: -3, debug: "true" },
        ));
        assert.ok(result.ok);
        assert.equal(result.settings.host, "gateway-1234-5678-9012.local");
        assert.equal(result.settings.port, 8444);
        assert.equal(result.settings.gatewayPin, "1234-5678-9012");
        assert.equal(result.settings.verifyCertificate, false);
        assert.equal(result.settings.shortPressIdle, "my");
        assert.deepEqual(result.settings.excluded, ["bad", "küche"]);
        assert.equal(result.settings.pollIntervalMs, 60_000);
        assert.equal(result.settings.batchWindowMs, 0);
        assert.equal(result.settings.debug, true);
    });

    it("falls back to 'stop' for unknown short press actions", () => {
        const result = parseConfiguration(configuration({ host: "10.0.0.2", token: "t" }, { shortPressIdle: "jump" }));
        assert.ok(result.ok);
        assert.equal(result.settings.shortPressIdle, "stop");
    });

    it("rejects an invalid gateway PIN and host", () => {
        const result = parseConfiguration(configuration({ host: "not a host!", token: "t", gatewayPin: "1234" }));
        assert.equal(result.ok, false);
        if (!result.ok)
            assert.equal(result.problems.length, 2);
    });

    it("accepts host names with scheme and port", () => {
        assert.deepEqual(parseHost("https://192.168.1.5:8443/"), { host: "192.168.1.5", port: 8443 });
        assert.deepEqual(parseHost("192.168.1.5"), { host: "192.168.1.5", port: undefined });
        assert.deepEqual(parseHost("[fd00::1]"), { host: "[fd00::1]", port: undefined });
        assert.equal(parseHost("a b"), undefined);

        const result = parseConfiguration(configuration({ host: "192.168.1.5:9443", port: 8443, token: "t" }));
        assert.ok(result.ok);
        assert.equal(result.settings.port, 9443);
    });
});
