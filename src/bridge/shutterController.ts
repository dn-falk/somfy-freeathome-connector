import { Direction, ForcedMode, Movement, ShutterInput } from "../fah/datapoints";
import { Logger, errorMessage } from "../log";
import { CommandSupersededError } from "../tahoma/commandQueue";
import { CLOSURE_MY_POSITION, CLOSURE_UNKNOWN, booleanValue, numberValue } from "../tahoma/rollerShutter";
import { StateNames, TahomaCommand, TahomaState } from "../tahoma/types";

/** What a short press does while the shutter is not moving. */
export type ShortPressIdleAction = "stop" | "my" | "move";

/** Outputs towards free@home. */
export interface ShutterView {
    setPosition(position: number): void;
    /** `lastDirection` is shown while the shutter stands still. */
    setMovement(movement: Movement, lastDirection: Direction): void;
    setForce(mode: ForcedMode): void;
}

export type SendCommand = (command: TahomaCommand) => Promise<string>;

export interface ShutterCapabilities {
    /** Device accepts `setClosure(position)`. */
    setClosure: boolean;
    /** Device accepts `my` (favourite position). */
    my: boolean;
    /** Device reports `core:MovingState`. */
    movingState: boolean;
}

export interface ShutterControllerOptions {
    shortPressIdle: ShortPressIdleAction;
}

export interface Clock {
    now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** After a command, "not moving" reports may still describe the time before the command. */
export const MOVING_REPORT_GRACE_MS = 2_000;
/** A command that did not lead to a reported movement within this time had no effect. */
export const OPTIMISTIC_TIMEOUT_MS = 5_000;
/** After a stop, "moving" reports may still describe the time before the stop. */
export const STOP_SUPPRESS_MS = 2_000;
/** Safety net if the end of a movement is never reported. */
export const MAX_MOVEMENT_MS = 180_000;
/** Longest wait for the box to confirm a stop (the event polling stays fast meanwhile). */
export const STOP_CONFIRMATION_MS = 10_000;

interface PendingMovement {
    direction: Direction;
    since: number;
}

interface ActiveExecution {
    execId: string | undefined;
    direction: Direction | undefined;
    since: number;
}

interface PendingStop {
    execId: string | undefined;
    since: number;
}

/**
 * Control logic for one roller shutter.
 *
 * - free@home inputs are turned into TaHoma commands immediately; nothing is awaited before
 *   the command is handed to the queue.
 * - The movement shown in free@home is set optimistically when a command is sent and then
 *   follows the states reported by the box (`core:MovingState`, `core:ClosureState`).
 * - A short press stops a moving shutter. Whether the shutter moves is known from the own
 *   commands and from the box, so a movement started by a Somfy remote can be stopped too.
 */
export class ShutterController {
    private position: number | undefined;
    private target: number | undefined;
    private myPosition: number | undefined;
    private reportedMoving = false;
    private movementDirection: Direction = "down";
    private pending: PendingMovement | undefined;
    private execution: ActiveExecution | undefined;
    /** A stop was sent and the box has not reported its end yet. */
    private stopping: PendingStop | undefined;
    private stoppedAt = Number.NEGATIVE_INFINITY;
    private movement: Movement = "stopped";
    /** Direction of the last movement shown in free@home. */
    private lastDirection: Direction | undefined;
    private movingSince = 0;
    private forced: "none" | "up" | "down" = "none";
    private preForcedPosition: number | undefined;
    private commandSeq = 0;

    constructor(
        readonly deviceURL: string,
        private readonly view: ShutterView,
        private readonly send: SendCommand,
        private readonly capabilities: ShutterCapabilities,
        private readonly options: ShutterControllerOptions,
        private readonly clock: Clock = systemClock,
        private readonly log = new Logger("shutter"),
    ) {}

    get isMoving(): boolean {
        return this.movement !== "stopped";
    }

    get currentMovement(): Movement {
        return this.movement;
    }

    get currentPosition(): number | undefined {
        return this.position;
    }

    /**
     * True while a command has been sent and its end was not yet reported. Meanwhile the box is
     * asked for changes every second, so that e.g. the position after a stop shows up quickly.
     */
    get hasPendingCommand(): boolean {
        return this.pending !== undefined || this.execution !== undefined || this.stopping !== undefined;
    }

    get isForced(): boolean {
        return this.forced !== "none";
    }

    // ---------------------------------------------------------------- free@home -> TaHoma

    handleInput(input: ShutterInput): void {
        if (input.type === "forced") {
            this.handleForced(input.mode);
            return;
        }
        if (this.forced !== "none") {
            this.log.info(`forced position active, ${input.type} ignored`);
            return;
        }
        switch (input.type) {
            case "move":
                if (input.direction === "up")
                    this.open();
                else
                    this.close();
                return;
            case "stopStep":
                this.handleShortPress(input.direction);
                return;
            case "position":
                this.moveToPosition(input.position);
                return;
        }
    }

    private handleShortPress(direction: Direction): void {
        if (this.isMoving) {
            this.stop();
            return;
        }
        switch (this.options.shortPressIdle) {
            case "my":
                if (this.capabilities.my)
                    this.my();
                else
                    this.stop();
                return;
            case "move":
                if (direction === "up")
                    this.open();
                else
                    this.close();
                return;
            case "stop":
                // Harmless for io motors and stops a movement the addon has not noticed yet
                // (e.g. started by a Somfy remote shortly before).
                this.stop();
                return;
        }
    }

    private handleForced(mode: ForcedMode): void {
        switch (mode) {
            case "up":
            case "down":
                if (this.forced === "none")
                    this.preForcedPosition = this.position;
                this.forced = mode;
                this.view.setForce(mode);
                this.log.info(`forced position ${mode}`);
                if (mode === "up")
                    this.open();
                else
                    this.close();
                return;
            case "restore": {
                const wasForced = this.forced !== "none";
                const previous = this.preForcedPosition;
                this.forced = "none";
                this.preForcedPosition = undefined;
                this.view.setForce("off");
                this.log.info("forced position ended, restoring previous position");
                if (wasForced && previous !== undefined)
                    this.moveToPosition(previous);
                return;
            }
            case "off":
                this.forced = "none";
                this.preForcedPosition = undefined;
                this.view.setForce("off");
                this.log.info("forced position ended");
                return;
        }
    }

    private open(): void {
        this.issue({ name: "open" }, "up");
    }

    private close(): void {
        this.issue({ name: "close" }, "down");
    }

    private my(): void {
        this.issue({ name: "my" }, this.directionTowards(this.myPosition));
    }

    private moveToPosition(position: number): void {
        if (position <= 0)
            this.open();
        else if (position >= 100)
            this.close();
        else if (this.capabilities.setClosure)
            this.issue({ name: "setClosure", parameters: [position] }, this.directionTowards(position));
        else if (position < 50)
            this.open();
        else
            this.close();
    }

    private stop(): void {
        const seq = ++this.commandSeq;
        const now = this.clock.now();
        this.pending = undefined;
        this.execution = undefined;
        this.stopping = { execId: undefined, since: now };
        this.reportedMoving = false;
        this.stoppedAt = now;
        this.log.info("stop");
        this.recompute();
        this.send({ name: "stop" }).then((execId) => {
            if (seq === this.commandSeq && this.stopping)
                this.stopping.execId = execId;
        }, (error) => {
            if (seq !== this.commandSeq)
                return;
            this.stopping = undefined;
            if (!(error instanceof CommandSupersededError))
                this.log.warn(`stop failed: ${errorMessage(error)}`);
        });
    }

    private issue(command: TahomaCommand, direction: Direction | undefined): void {
        const seq = ++this.commandSeq;
        const now = this.clock.now();
        this.log.info(`${command.name}${command.parameters ? `(${command.parameters.join(", ")})` : ""}`);
        this.pending = direction ? { direction, since: now } : undefined;
        this.execution = { execId: undefined, direction, since: now };
        this.stopping = undefined;
        if (direction)
            this.movementDirection = direction;
        this.recompute();

        this.send(command).then((execId) => {
            if (seq === this.commandSeq && this.execution)
                this.execution.execId = execId;
        }, (error) => {
            if (error instanceof CommandSupersededError)
                return;
            this.log.warn(`${command.name} failed: ${errorMessage(error)}`);
            if (seq === this.commandSeq) {
                this.pending = undefined;
                this.execution = undefined;
                this.recompute();
            }
        });
    }

    private directionTowards(target: number | undefined): Direction | undefined {
        if (target === undefined || this.position === undefined || target === this.position)
            return undefined;
        return target > this.position ? "down" : "up";
    }

    // ---------------------------------------------------------------- TaHoma -> free@home

    /** Applies states from `/setup/devices` or a `DeviceStateChangedEvent`. */
    applyStates(states: readonly TahomaState[]): void {
        let moving: boolean | undefined;
        for (const state of states) {
            switch (state.name) {
                case StateNames.closure:
                    this.applyClosure(numberValue(state.value));
                    break;
                case StateNames.targetClosure: {
                    const target = numberValue(state.value);
                    if (target !== undefined && target >= 0 && target <= 100)
                        this.target = target;
                    break;
                }
                case StateNames.memorized1Position: {
                    const my = numberValue(state.value);
                    if (my !== undefined && my >= 0 && my <= 100)
                        this.myPosition = my;
                    break;
                }
                case StateNames.moving:
                    moving = booleanValue(state.value);
                    break;
            }
        }
        if (moving !== undefined)
            this.applyMoving(moving);
        this.recompute();
    }

    /**
     * Tracks the executions of the own commands: the end of a stop, and the end of a movement
     * for devices without MovingState.
     */
    onExecutionState(execId: string | undefined, newState: string | undefined, failureType?: string): void {
        if (!execId || (newState !== "COMPLETED" && newState !== "FAILED"))
            return;
        const failure = newState === "FAILED" && failureType && failureType !== "CMDCANCELLED" ? failureType : undefined;
        if (this.stopping?.execId === execId) {
            this.stopping = undefined;
            if (failure)
                this.log.warn(`stop failed on the box: ${failure}`);
            return;
        }
        if (!this.execution || this.execution.execId !== execId)
            return;
        if (failure)
            this.log.warn(`command failed on the box: ${failure}`);
        this.execution = undefined;
        if (!this.capabilities.movingState)
            this.pending = undefined;
        this.recompute();
    }

    /** Timeouts; called periodically. */
    tick(): void {
        const now = this.clock.now();
        if (this.stopping && now - this.stopping.since > STOP_CONFIRMATION_MS)
            this.stopping = undefined;
        if (this.pending && this.capabilities.movingState && !this.reportedMoving
            && now - this.pending.since > OPTIMISTIC_TIMEOUT_MS) {
            // The box never reported a movement, e.g. "open" while already open.
            this.pending = undefined;
            this.execution = undefined;
        }
        if (this.movement !== "stopped" && now - this.movingSince > MAX_MOVEMENT_MS) {
            this.log.warn("end of movement was not reported, assuming the shutter stopped");
            this.pending = undefined;
            this.execution = undefined;
            this.reportedMoving = false;
        }
        this.recompute();
    }

    /** Writes all outputs again (after (re)connecting). */
    publish(): void {
        this.showMovement();
        if (this.position !== undefined)
            this.view.setPosition(this.position);
        this.view.setForce(this.forced === "none" ? "off" : this.forced);
    }

    private applyClosure(value: number | undefined): void {
        let position = value;
        if (position === CLOSURE_MY_POSITION)
            position = this.myPosition;
        if (position === undefined || position === CLOSURE_UNKNOWN || position < 0 || position > 100)
            return;
        if (this.reportedMoving && this.position !== undefined && position !== this.position)
            this.movementDirection = position > this.position ? "down" : "up";
        this.position = position;
        this.view.setPosition(position);
    }

    private applyMoving(moving: boolean): void {
        const now = this.clock.now();
        if (moving) {
            if (now - this.stoppedAt < STOP_SUPPRESS_MS)
                return;
            if (!this.reportedMoving && !this.pending) {
                // Movement started outside of free@home (Somfy remote, TaHoma app, timer).
                this.movementDirection = this.inferDirection() ?? this.movementDirection;
            }
            this.reportedMoving = true;
            this.pending = undefined;
            return;
        }
        this.reportedMoving = false;
        if (this.pending && now - this.pending.since < MOVING_REPORT_GRACE_MS)
            return;
        this.pending = undefined;
        this.execution = undefined;
    }

    private inferDirection(): Direction | undefined {
        if (this.target === undefined || this.position === undefined || this.target === this.position)
            return undefined;
        return this.target > this.position ? "down" : "up";
    }

    private recompute(): void {
        let movement: Movement = "stopped";
        if (this.pending)
            movement = this.pending.direction;
        else if (this.reportedMoving)
            movement = this.movementDirection;
        else if (!this.capabilities.movingState && this.execution?.direction)
            movement = this.execution.direction;

        if (movement === this.movement)
            return;
        if (this.movement === "stopped")
            this.movingSince = this.clock.now();
        this.movement = movement;
        if (movement !== "stopped")
            this.lastDirection = movement;
        this.showMovement();
    }

    private showMovement(): void {
        // Not known after a start; a closed shutter got there moving down.
        const lastDirection = this.lastDirection ?? (this.position === 100 ? "down" : "up");
        this.view.setMovement(this.movement, lastDirection);
    }
}
