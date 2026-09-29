import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
    MAX_MOVEMENT_MS,
    MOVING_REPORT_GRACE_MS,
    OPTIMISTIC_TIMEOUT_MS,
    STOP_CONFIRMATION_MS,
    ShortPressIdleAction,
    ShutterCapabilities,
    ShutterController,
} from "../src/bridge/shutterController";
import { ShutterInput } from "../src/fah/datapoints";
import { Logger } from "../src/log";
import { CommandSupersededError } from "../src/tahoma/commandQueue";
import { TahomaCommand, TahomaState } from "../src/tahoma/types";
import { FakeClock, RecordingView } from "./support/fakes";

Logger.silent = true;

const IO_SHUTTER: ShutterCapabilities = { setClosure: true, my: true, movingState: true };

function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

const closure = (value: number): TahomaState => ({ name: "core:ClosureState", type: 1, value });
const target = (value: number): TahomaState => ({ name: "core:TargetClosureState", type: 1, value });
const moving = (value: boolean): TahomaState => ({ name: "core:MovingState", type: 6, value });
const my = (value: number): TahomaState => ({ name: "core:Memorized1PositionState", type: 1, value });

describe("ShutterController", () => {
    let clock: FakeClock;
    let view: RecordingView;
    let sent: TahomaCommand[];
    let sendResult: (command: TahomaCommand) => Promise<string>;

    function controller(options: { shortPressIdle?: ShortPressIdleAction; capabilities?: ShutterCapabilities } = {}) {
        return new ShutterController(
            "io://1234-5678-9012/1",
            view,
            (command) => {
                sent.push(command);
                return sendResult(command);
            },
            options.capabilities ?? IO_SHUTTER,
            { shortPressIdle: options.shortPressIdle ?? "stop" },
            clock,
        );
    }

    const press = (shutter: ShutterController, input: ShutterInput) => shutter.handleInput(input);

    beforeEach(() => {
        clock = new FakeClock();
        view = new RecordingView();
        sent = [];
        sendResult = async () => "exec-1";
    });

    describe("free@home -> TaHoma", () => {
        it("long press opens and closes immediately and shows the movement", () => {
            const shutter = controller();
            shutter.applyStates([closure(50)]);

            press(shutter, { type: "move", direction: "down" });
            assert.deepEqual(sent, [{ name: "close" }]);
            assert.equal(view.lastMovement, "down");

            press(shutter, { type: "move", direction: "up" });
            assert.deepEqual(sent[1], { name: "open" });
            assert.equal(view.lastMovement, "up");
        });

        it("short press stops a moving shutter", () => {
            const shutter = controller();
            press(shutter, { type: "move", direction: "down" });
            press(shutter, { type: "stopStep", direction: "down" });
            assert.deepEqual(sent, [{ name: "close" }, { name: "stop" }]);
            assert.equal(view.lastMovement, "stopped");
            assert.equal(shutter.isMoving, false);
        });

        it("waits for the box to confirm a stop", async () => {
            sendResult = async (command) => `exec-${command.name}`;
            const shutter = controller();
            press(shutter, { type: "move", direction: "down" });
            press(shutter, { type: "stopStep", direction: "down" });
            assert.equal(shutter.isMoving, false);
            assert.equal(shutter.hasPendingCommand, true, "stop not confirmed yet");

            await flush();
            shutter.onExecutionState("exec-close", "FAILED", "CMDCANCELLED");
            shutter.onExecutionState("exec-stop", "IN_PROGRESS");
            assert.equal(shutter.hasPendingCommand, true);
            shutter.onExecutionState("exec-stop", "COMPLETED");
            assert.equal(shutter.hasPendingCommand, false);
        });

        it("stops waiting for the confirmation of a stop after a timeout or a failed request", async () => {
            const shutter = controller();
            press(shutter, { type: "stopStep", direction: "down" });
            clock.advance(STOP_CONFIRMATION_MS + 1);
            shutter.tick();
            assert.equal(shutter.hasPendingCommand, false);

            sendResult = async () => {
                throw new Error("ECONNREFUSED");
            };
            press(shutter, { type: "stopStep", direction: "down" });
            assert.equal(shutter.hasPendingCommand, true);
            await flush();
            assert.equal(shutter.hasPendingCommand, false);
        });

        it("a new command replaces the wait for a stop", async () => {
            sendResult = async (command) => `exec-${command.name}`;
            const shutter = controller();
            shutter.applyStates([closure(50)]);
            press(shutter, { type: "stopStep", direction: "down" });
            press(shutter, { type: "move", direction: "up" });
            await flush();
            shutter.onExecutionState("exec-stop", "COMPLETED");
            assert.equal(shutter.hasPendingCommand, true, "open is still running");
            assert.equal(view.lastMovement, "up");
        });

        it("short press stops a movement reported by the box (e.g. Somfy remote)", () => {
            const shutter = controller({ shortPressIdle: "move" });
            shutter.applyStates([closure(0), target(100), moving(true)]);
            assert.equal(view.lastMovement, "down");

            press(shutter, { type: "stopStep", direction: "up" });
            assert.deepEqual(sent, [{ name: "stop" }]);
        });

        it("short press while idle: stop (default), my or full movement", () => {
            const byDefault = controller();
            press(byDefault, { type: "stopStep", direction: "down" });
            assert.deepEqual(sent, [{ name: "stop" }]);

            sent = [];
            const withMy = controller({ shortPressIdle: "my" });
            withMy.applyStates([closure(0), my(70)]);
            press(withMy, { type: "stopStep", direction: "up" });
            assert.deepEqual(sent, [{ name: "my" }]);
            assert.equal(view.lastMovement, "down");

            sent = [];
            const withMove = controller({ shortPressIdle: "move" });
            press(withMove, { type: "stopStep", direction: "up" });
            assert.deepEqual(sent, [{ name: "open" }]);
        });

        it("falls back to stop if the device has no 'my' command", () => {
            const shutter = controller({ shortPressIdle: "my", capabilities: { ...IO_SHUTTER, my: false } });
            press(shutter, { type: "stopStep", direction: "up" });
            assert.deepEqual(sent, [{ name: "stop" }]);
        });

        it("positions: open/close for the end positions, setClosure in between", () => {
            const shutter = controller();
            shutter.applyStates([closure(20)]);
            press(shutter, { type: "position", position: 0, source: "setpoint" });
            press(shutter, { type: "position", position: 100, source: "setpoint" });
            press(shutter, { type: "position", position: 60, source: "scene" });
            assert.deepEqual(sent, [{ name: "open" }, { name: "close" }, { name: "setClosure", parameters: [60] }]);
            assert.equal(view.lastMovement, "down");
        });

        it("does not show a movement if the target equals the current position", () => {
            const shutter = controller();
            shutter.applyStates([closure(60)]);
            press(shutter, { type: "position", position: 60, source: "setpoint" });
            assert.deepEqual(sent, [{ name: "setClosure", parameters: [60] }]);
            assert.equal(shutter.isMoving, false);
        });

        it("uses open/close if setClosure is not available", () => {
            const shutter = controller({ capabilities: { ...IO_SHUTTER, setClosure: false } });
            press(shutter, { type: "position", position: 30, source: "setpoint" });
            press(shutter, { type: "position", position: 70, source: "setpoint" });
            assert.deepEqual(sent, [{ name: "open" }, { name: "close" }]);
        });
    });

    describe("forced position", () => {
        it("moves to the forced position, blocks other commands and restores afterwards", () => {
            const shutter = controller();
            shutter.applyStates([closure(40)]);

            press(shutter, { type: "forced", mode: "up" });
            assert.deepEqual(sent, [{ name: "open" }]);
            assert.deepEqual(view.forces, ["up"]);
            assert.equal(shutter.isForced, true);

            press(shutter, { type: "move", direction: "down" });
            press(shutter, { type: "stopStep", direction: "down" });
            press(shutter, { type: "position", position: 80, source: "setpoint" });
            assert.equal(sent.length, 1);

            shutter.applyStates([closure(0)]);
            press(shutter, { type: "forced", mode: "restore" });
            assert.deepEqual(sent[1], { name: "setClosure", parameters: [40] });
            assert.equal(view.forces[view.forces.length - 1], "off");
            assert.equal(shutter.isForced, false);
        });

        it("'off' ends the forced position without moving", () => {
            const shutter = controller();
            press(shutter, { type: "forced", mode: "down" });
            press(shutter, { type: "forced", mode: "off" });
            assert.deepEqual(sent, [{ name: "close" }]);
            press(shutter, { type: "move", direction: "up" });
            assert.deepEqual(sent[1], { name: "open" });
        });
    });

    describe("TaHoma -> free@home", () => {
        it("forwards positions, including the 'my' preset value", () => {
            const shutter = controller();
            shutter.applyStates([my(35), closure(10)]);
            shutter.applyStates([closure(108)]);
            shutter.applyStates([closure(124)]);
            assert.deepEqual(view.positions, [10, 35]);
            assert.equal(shutter.currentPosition, 35);
        });

        it("hands the optimistic movement over to the reported movement", () => {
            const shutter = controller();
            shutter.applyStates([closure(0), moving(false)]);
            press(shutter, { type: "move", direction: "down" });
            assert.equal(view.lastMovement, "down");

            // A "not moving" report right after the command describes the time before it.
            clock.advance(200);
            shutter.applyStates([moving(false)]);
            assert.equal(view.lastMovement, "down");

            clock.advance(300);
            shutter.applyStates([target(100), moving(true)]);
            assert.equal(view.lastMovement, "down");

            clock.advance(10_000);
            shutter.tick();
            assert.equal(view.lastMovement, "down");

            shutter.applyStates([closure(100), moving(false)]);
            assert.equal(view.lastMovement, "stopped");
            assert.equal(shutter.hasPendingCommand, false);
        });

        it("ends the optimistic movement if the box never reports one", () => {
            const shutter = controller();
            shutter.applyStates([closure(0)]);
            press(shutter, { type: "move", direction: "up" });
            assert.equal(shutter.isMoving, true);
            clock.advance(OPTIMISTIC_TIMEOUT_MS + 1);
            shutter.tick();
            assert.equal(shutter.isMoving, false);
            assert.equal(view.lastMovement, "stopped");
        });

        it("accepts 'not moving' after the grace period", () => {
            const shutter = controller();
            press(shutter, { type: "move", direction: "up" });
            clock.advance(MOVING_REPORT_GRACE_MS + 1);
            shutter.applyStates([moving(false)]);
            assert.equal(shutter.isMoving, false);
        });

        it("ignores stale 'moving' reports right after a stop", () => {
            const shutter = controller();
            shutter.applyStates([closure(0), target(100), moving(true)]);
            press(shutter, { type: "stopStep", direction: "down" });
            assert.equal(view.lastMovement, "stopped");

            clock.advance(300);
            shutter.applyStates([moving(true)]);
            assert.equal(view.lastMovement, "stopped");

            clock.advance(5_000);
            shutter.applyStates([moving(true)]);
            assert.equal(view.lastMovement, "down");
        });

        it("infers the direction of external movements", () => {
            const shutter = controller();
            shutter.applyStates([closure(80), target(20), moving(true)]);
            assert.equal(view.lastMovement, "up");
            shutter.applyStates([closure(70)]);
            shutter.applyStates([closure(75)]);
            assert.equal(view.lastMovement, "down");
            shutter.applyStates([moving(false)]);
            assert.equal(view.lastMovement, "stopped");
        });

        it("uses the execution state for devices without MovingState", () => {
            const shutter = controller({ capabilities: { ...IO_SHUTTER, movingState: false } });
            sendResult = async () => "exec-42";
            press(shutter, { type: "move", direction: "down" });
            return flush().then(() => {
                clock.advance(OPTIMISTIC_TIMEOUT_MS + 1);
                shutter.tick();
                assert.equal(view.lastMovement, "down");
                shutter.onExecutionState("exec-other", "COMPLETED");
                assert.equal(view.lastMovement, "down");
                shutter.onExecutionState("exec-42", "IN_PROGRESS");
                assert.equal(view.lastMovement, "down");
                shutter.onExecutionState("exec-42", "COMPLETED");
                assert.equal(view.lastMovement, "stopped");
            });
        });

        it("gives up on movements whose end is never reported", () => {
            const shutter = controller();
            shutter.applyStates([closure(0), target(100), moving(true)]);
            clock.advance(MAX_MOVEMENT_MS + 1);
            shutter.tick();
            assert.equal(view.lastMovement, "stopped");
        });

        it("reverts the optimistic movement if the command fails", async () => {
            sendResult = async () => {
                throw new Error("ECONNREFUSED");
            };
            const shutter = controller();
            press(shutter, { type: "move", direction: "down" });
            assert.equal(view.lastMovement, "down");
            await flush();
            assert.equal(view.lastMovement, "stopped");
        });

        it("keeps the state if a command was replaced by a newer one", async () => {
            sendResult = async (command) => {
                if (command.name === "close")
                    throw new CommandSupersededError("io://1234-5678-9012/1");
                return "exec-2";
            };
            const shutter = controller();
            press(shutter, { type: "move", direction: "down" });
            press(shutter, { type: "move", direction: "up" });
            await flush();
            assert.equal(view.lastMovement, "up");
        });

        it("shows the last moving direction while the shutter stands still", () => {
            const shutter = controller();
            shutter.applyStates([closure(40)]);
            shutter.publish();
            assert.equal(view.lastDirection, "up", "unknown after a start");

            press(shutter, { type: "move", direction: "down" });
            shutter.applyStates([moving(true)]);
            shutter.applyStates([closure(60), moving(false)]);
            assert.equal(view.lastMovement, "stopped");
            assert.equal(view.lastDirection, "down");

            shutter.applyStates([closure(60), target(0), moving(true)]);
            assert.equal(view.lastMovement, "up");
            shutter.applyStates([closure(0), moving(false)]);
            assert.equal(view.lastMovement, "stopped");
            assert.equal(view.lastDirection, "up");
        });

        it("assumes the last direction was down for a closed shutter after a start", () => {
            const shutter = controller();
            shutter.applyStates([closure(100)]);
            shutter.publish();
            assert.equal(view.lastMovement, "stopped");
            assert.equal(view.lastDirection, "down");
        });

        it("publishes all outputs on request", () => {
            const shutter = controller();
            shutter.applyStates([closure(30)]);
            view.movements = [];
            view.positions = [];
            shutter.publish();
            assert.deepEqual(view.movements, ["stopped"]);
            assert.deepEqual(view.positions, [30]);
            assert.deepEqual(view.forces, ["off"]);
        });
    });
});
