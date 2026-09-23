import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PairingIds } from "@busch-jaeger/free-at-home";

import { PairingId, moveInfoValue, parseInputDatapoint, parsePercentage } from "../src/fah/datapoints";

describe("free@home datapoints", () => {
    it("uses the pairing IDs of the free@home library", () => {
        for (const [name, value] of Object.entries(PairingId))
            assert.equal(value, (PairingIds as unknown as Record<string, number>)[name], name);
    });

    it("parses long press up/down", () => {
        assert.deepEqual(parseInputDatapoint(PairingId.AL_MOVE_UP_DOWN, "0"), { type: "move", direction: "up" });
        assert.deepEqual(parseInputDatapoint(PairingId.AL_MOVE_UP_DOWN, "1"), { type: "move", direction: "down" });
        assert.equal(parseInputDatapoint(PairingId.AL_MOVE_UP_DOWN, "2"), undefined);
    });

    it("parses short press (stop/step)", () => {
        assert.deepEqual(parseInputDatapoint(PairingId.AL_STOP_STEP_UP_DOWN, "0"), { type: "stopStep", direction: "up" });
        assert.deepEqual(parseInputDatapoint(PairingId.AL_STOP_STEP_UP_DOWN, "1"), { type: "stopStep", direction: "down" });
    });

    it("parses positions from the app and from scenes", () => {
        assert.deepEqual(parseInputDatapoint(PairingId.AL_SET_ABSOLUTE_POSITION_BLINDS_PERCENTAGE, "42"),
            { type: "position", position: 42, source: "setpoint" });
        assert.deepEqual(parseInputDatapoint(PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE, "100"),
            { type: "position", position: 100, source: "scene" });
        assert.equal(parseInputDatapoint(PairingId.AL_SET_ABSOLUTE_POSITION_BLINDS_PERCENTAGE, "abc"), undefined);
    });

    it("parses forced positions", () => {
        assert.deepEqual(parseInputDatapoint(PairingId.AL_FORCED_UP_DOWN, "0"), { type: "forced", mode: "off" });
        assert.deepEqual(parseInputDatapoint(PairingId.AL_FORCED_UP_DOWN, "1"), { type: "forced", mode: "restore" });
        assert.deepEqual(parseInputDatapoint(PairingId.AL_FORCED_UP_DOWN, "2"), { type: "forced", mode: "up" });
        assert.deepEqual(parseInputDatapoint(PairingId.AL_FORCED_UP_DOWN, "3"), { type: "forced", mode: "down" });
        assert.equal(parseInputDatapoint(PairingId.AL_FORCED_UP_DOWN, "4"), undefined);
    });

    it("reports the movement with the last moving direction", () => {
        assert.equal(moveInfoValue("stopped", "up"), "0");
        assert.equal(moveInfoValue("stopped", "down"), "1");
        assert.equal(moveInfoValue("up", "up"), "2");
        assert.equal(moveInfoValue("down", "down"), "3");
    });

    it("ignores unknown datapoints", () => {
        assert.equal(parseInputDatapoint(0x0001, "1"), undefined);
    });

    it("clamps and rounds percentages", () => {
        assert.equal(parsePercentage("-5"), 0);
        assert.equal(parsePercentage("150"), 100);
        assert.equal(parsePercentage("33.6"), 34);
        assert.equal(parsePercentage(""), undefined);
    });
});
