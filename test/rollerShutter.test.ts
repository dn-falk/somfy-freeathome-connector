import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    availabilityFromStates,
    isDeviceAvailable,
    isExcluded,
    isSupportedRollerShutter,
    nativeIdFor,
    parseExcludedNames,
} from "../src/tahoma/rollerShutter";
import { TahomaDevice } from "../src/tahoma/types";

// Shape taken from a real TaHoma Switch (io:RollerShutterWithLowSpeedManagementIOComponent).
function ioRollerShutter(overrides: Partial<TahomaDevice> = {}): TahomaDevice {
    return {
        deviceURL: "io://1234-5678-9012/12189845",
        label: "Wohnzimmer links",
        available: true,
        enabled: true,
        controllableName: "io:RollerShutterWithLowSpeedManagementIOComponent",
        definition: {
            uiClass: "RollerShutter",
            widgetName: "PositionableRollerShutterWithLowSpeedManagement",
            commands: ["close", "down", "identify", "my", "open", "setClosure", "setClosureAndLinearSpeed", "stop", "up", "wink"]
                .map((commandName) => ({ commandName })),
            states: [{ name: "core:ClosureState" }, { name: "core:MovingState" }],
        },
        states: [
            { name: "core:ClosureState", type: 1, value: 0 },
            { name: "core:StatusState", type: 3, value: "available" },
        ],
        ...overrides,
    };
}

describe("roller shutter helpers", () => {
    it("accepts io roller shutters", () => {
        assert.equal(isSupportedRollerShutter(ioRollerShutter()), true);
    });

    it("rejects RTS devices, other device classes and disabled devices", () => {
        assert.equal(isSupportedRollerShutter(ioRollerShutter({ deviceURL: "rts://1234-5678-9012/16711680" })), false);
        assert.equal(isSupportedRollerShutter(ioRollerShutter({
            definition: { ...ioRollerShutter().definition, uiClass: "ExteriorVenetianBlind" },
        })), false);
        assert.equal(isSupportedRollerShutter(ioRollerShutter({ enabled: false })), false);
        assert.equal(isSupportedRollerShutter(ioRollerShutter({
            definition: { uiClass: "RollerShutter", commands: [{ commandName: "open" }] },
        })), false);
    });

    it("derives a stable free@home id without the gateway PIN", () => {
        assert.equal(nativeIdFor("io://1234-5678-9012/12189845"), "somfy-io-12189845");
        assert.equal(nativeIdFor("io://9999-8888-7777/12189845"), "somfy-io-12189845");
        assert.equal(nativeIdFor("io://1234-5678-9012/12189845#2"), "somfy-io-12189845-2");
        assert.match(nativeIdFor("weird url with spaces and a very long text ".repeat(4)), /^[a-zA-Z0-9_-]{1,64}$/);
    });

    it("evaluates availability", () => {
        assert.equal(isDeviceAvailable(ioRollerShutter()), true);
        assert.equal(isDeviceAvailable(ioRollerShutter({ available: false })), false);
        assert.equal(isDeviceAvailable(ioRollerShutter({ states: [{ name: "core:StatusState", value: "unavailable" }] })), false);
        assert.equal(availabilityFromStates([{ name: "core:ClosureState", value: 3 }]), undefined);
    });

    it("excludes devices by name (case insensitive) or device URL", () => {
        const excluded = parseExcludedNames(" Wohnzimmer Links ; Bad,\n io://1234-5678-9012/1 ");
        assert.deepEqual(excluded, ["wohnzimmer links", "bad", "io://1234-5678-9012/1"]);
        assert.equal(isExcluded(ioRollerShutter(), excluded), true);
        assert.equal(isExcluded(ioRollerShutter({ label: "Küche" }), excluded), false);
        assert.equal(isExcluded(ioRollerShutter({ label: "Küche", deviceURL: "io://1234-5678-9012/1" }), excluded), true);
        assert.deepEqual(parseExcludedNames(undefined), []);
    });
});
