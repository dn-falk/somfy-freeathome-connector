import { EventEmitter } from "node:events";

import { FahShutterDevice } from "../fah/shutterDevice";
import { Logger, errorMessage } from "../log";
import { TahomaApi, TahomaClient, TahomaClientOptions } from "../tahoma/client";
import { CommandQueue } from "../tahoma/commandQueue";
import {
    availabilityFromStates,
    commandNames,
    hasState,
    isDeviceAvailable,
    isExcluded,
    isSupportedRollerShutter,
    nativeIdFor,
} from "../tahoma/rollerShutter";
import { GatewaySession, SetupInfo } from "../tahoma/session";
import { EventNames, StateNames, TahomaCommand, TahomaDevice, TahomaEvent } from "../tahoma/types";
import { Clock, ShortPressIdleAction, ShutterCapabilities, ShutterController, systemClock } from "./shutterController";

export interface BridgeSettings {
    tahoma: TahomaClientOptions;
    shortPressIdle: ShortPressIdleAction;
    /** Normalised names or device URLs of roller shutters that are not created in free@home. */
    excluded: string[];
    idlePollIntervalMs: number;
    batchWindowMs: number;
}

export interface ShutterDeviceProvider {
    getOrCreate(nativeId: string, name: string): Promise<FahShutterDevice>;
    /** All free@home devices created so far (also those of earlier configurations). */
    createdDevices(): Promise<FahShutterDevice[]>;
}

export interface BridgeDependencies {
    devices: ShutterDeviceProvider;
    createApi?: (options: TahomaClientOptions, log: Logger) => TahomaApi;
    clock?: Clock;
    log?: Logger;
    tickIntervalMs?: number;
    /** Waiting times between reconnection attempts (tests use short ones). */
    retryDelaysMs?: number[];
}

export type BridgeState = "connecting" | "online" | "offline";

export interface BridgeStatus {
    state: BridgeState;
    shutterCount: number;
    protocolVersion?: string;
    error?: Error;
}

interface ManagedShutter {
    label: string;
    device: FahShutterDevice;
    controller: ShutterController;
    /** The last command sent to the shutter (for the debug log). */
    lastCommand?: SentCommand;
}

/** A command sent by the addon, used to put the events of the box in relation to it. */
interface SentCommand {
    description: string;
    /** When the command was handed to the queue. */
    at: number;
}

const ACTIVE_POLL_INTERVAL_MS = 1_000;
/** Device state changes within this time after a command are logged with the time since it. */
const COMMAND_RELATION_MS = 60_000;
/** Executions whose end is never reported are forgotten after this many newer ones. */
const MAX_TRACKED_EXECUTIONS = 50;

export declare interface Bridge {
    on(event: "status", listener: (status: BridgeStatus) => void): this;
}

/**
 * Connects the TaHoma roller shutters with virtual free@home blind actuators:
 * creates the free@home devices, forwards commands and reports positions and reachability.
 */
export class Bridge extends EventEmitter {
    private readonly api: TahomaApi;
    private readonly queue: CommandQueue;
    private readonly session: GatewaySession;
    private readonly shutters = new Map<string, ManagedShutter>();
    /** Commands of executions that have not finished yet, by execution id (for the debug log). */
    private readonly executions = new Map<string, SentCommand>();
    private readonly clock: Clock;
    private readonly log: Logger;
    private tickTimer: NodeJS.Timeout | undefined;
    private syncChain: Promise<void> = Promise.resolve();
    private stopped = false;

    constructor(private readonly settings: BridgeSettings, private readonly deps: BridgeDependencies) {
        super();
        this.log = deps.log ?? new Logger("bridge");
        this.clock = deps.clock ?? systemClock;
        const createApi = deps.createApi ?? ((options, log) => new TahomaClient(options, log));
        this.api = createApi(settings.tahoma, this.log.child("tahoma"));
        this.queue = new CommandQueue(this.api, settings.batchWindowMs, this.log.child("queue"));
        this.session = new GatewaySession(this.api, {
            idleIntervalMs: settings.idlePollIntervalMs,
            activeIntervalMs: Math.min(ACTIVE_POLL_INTERVAL_MS, settings.idlePollIntervalMs),
            retryDelaysMs: deps.retryDelaysMs,
        }, this.log.child("session"));
    }

    get status(): BridgeStatus {
        const state: BridgeState = this.session.state === "online" ? "online"
            : this.session.state === "offline" ? "offline" : "connecting";
        return {
            state,
            shutterCount: this.shutters.size,
            protocolVersion: this.session.protocolVersion,
            error: this.session.lastError,
        };
    }

    start(): void {
        this.log.info(`connecting to TaHoma at ${this.settings.tahoma.host}:${this.settings.tahoma.port}`);
        this.session.on("setup", (info) => this.onSetup(info));
        this.session.on("events", (events) => this.onEvents(events));
        this.session.on("offline", (error) => this.onOffline(error));
        this.session.start();
        this.tickTimer = setInterval(() => this.tick(), this.deps.tickIntervalMs ?? 500);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.tickTimer)
            clearInterval(this.tickTimer);
        this.session.removeAllListeners();
        this.queue.close();
        await this.session.stop();
        this.api.close();
        for (const shutter of this.shutters.values())
            shutter.device.unbind();
        this.shutters.clear();
    }

    /** Reads the device list of the box again. */
    resync(): void {
        this.session.requestResync();
    }

    /** Sends all states to free@home again (e.g. after the System Access Point restarted). */
    republish(): void {
        for (const shutter of this.shutters.values())
            shutter.controller.publish();
    }

    /** Number of managed roller shutters (for tests and status). */
    get shutterCount(): number {
        return this.shutters.size;
    }

    controllerFor(deviceURL: string): ShutterController | undefined {
        return this.shutters.get(deviceURL)?.controller;
    }

    private onSetup(info: SetupInfo): void {
        this.syncChain = this.syncChain
            .then(() => this.syncDevices(info.devices))
            .catch((error) => this.log.error(`device synchronisation failed: ${errorMessage(error)}`, error))
            .finally(() => this.emitStatus());
    }

    private async syncDevices(devices: TahomaDevice[]): Promise<void> {
        const shutters = devices.filter(isSupportedRollerShutter);
        const wanted = shutters.filter((device) => !isExcluded(device, this.settings.excluded));
        this.log.info(`found ${shutters.length} io roller shutter(s)`
            + (shutters.length !== wanted.length ? `, ${shutters.length - wanted.length} excluded` : "")
            + (wanted.length ? `: ${wanted.map((device) => device.label).join(", ")}` : ""));

        const present = new Set<string>();
        for (const device of wanted) {
            if (this.stopped)
                return;
            const shutter = this.shutters.get(device.deviceURL) ?? await this.addShutter(device);
            if (!shutter || this.stopped)
                continue;
            present.add(device.deviceURL);
            shutter.controller.applyStates(device.states ?? []);
            await this.setShutterAvailable(shutter, isDeviceAvailable(device), true);
        }

        for (const [deviceURL, shutter] of this.shutters) {
            if (present.has(deviceURL))
                continue;
            this.log.info(`roller shutter '${shutter.label}' is no longer available on the TaHoma`);
            shutter.device.unbind();
            await shutter.device.setAvailable(false);
            this.shutters.delete(deviceURL);
        }

        // free@home devices of shutters that were removed from the box or are excluded now.
        const managed = new Set([...this.shutters.values()].map((shutter) => shutter.device));
        for (const device of await this.deps.devices.createdDevices()) {
            if (!managed.has(device) && device.isAvailable) {
                this.log.info(`free@home device '${device.name}' has no roller shutter on the TaHoma, marking it unreachable`);
                await device.setAvailable(false);
            }
        }
        this.updateActivity();
    }

    private async addShutter(device: TahomaDevice): Promise<ManagedShutter | undefined> {
        const label = device.label?.trim() || device.deviceURL;
        let fahDevice: FahShutterDevice;
        try {
            fahDevice = await this.deps.devices.getOrCreate(nativeIdFor(device.deviceURL), label);
        } catch (error) {
            this.log.error(`could not create free@home device for '${label}': ${errorMessage(error)}`);
            return undefined;
        }
        if (this.stopped)
            return undefined;

        const commands = commandNames(device);
        const capabilities: ShutterCapabilities = {
            setClosure: commands.has("setClosure"),
            my: commands.has("my"),
            movingState: hasState(device, StateNames.moving),
        };
        const controller = new ShutterController(
            device.deviceURL,
            fahDevice,
            (command) => this.sendCommand(device.deviceURL, label, command),
            capabilities,
            { shortPressIdle: this.settings.shortPressIdle },
            this.clock,
            this.log.child(label),
        );
        fahDevice.bind((input) => {
            controller.handleInput(input);
            this.updateActivity();
        });
        const shutter: ManagedShutter = { label, device: fahDevice, controller };
        this.shutters.set(device.deviceURL, shutter);
        return shutter;
    }

    /** Hands a command to the queue and remembers it to relate the events of the box to it. */
    private sendCommand(deviceURL: string, label: string, command: TahomaCommand): Promise<string> {
        const at = this.clock.now();
        const shutter = this.shutters.get(deviceURL);
        if (shutter)
            shutter.lastCommand = { description: command.name, at };
        const result = this.queue.send(deviceURL, command);
        result.then((execId) => this.rememberExecution(execId, `${command.name} '${label}'`, at), () => undefined);
        return result;
    }

    private rememberExecution(execId: string, description: string, at: number): void {
        const known = this.executions.get(execId);
        if (known) {
            // Several shutters in one request.
            known.description += `, ${description}`;
            return;
        }
        this.executions.set(execId, { description, at });
        if (this.executions.size > MAX_TRACKED_EXECUTIONS) {
            const oldest = this.executions.keys().next();
            if (!oldest.done)
                this.executions.delete(oldest.value);
        }
    }

    private onEvents(events: TahomaEvent[]): void {
        let resync = false;
        for (const event of events) {
            if (Logger.debugEnabled)
                this.log.debug(`event ${this.describeEvent(event)}`);
            if (event.name === EventNames.executionStateChanged && event.execId
                && (event.newState === "COMPLETED" || event.newState === "FAILED"))
                this.executions.delete(event.execId);
            switch (event.name) {
                case EventNames.deviceStateChanged: {
                    const shutter = event.deviceURL ? this.shutters.get(event.deviceURL) : undefined;
                    if (!shutter)
                        break;
                    shutter.controller.applyStates(event.deviceStates ?? []);
                    const available = availabilityFromStates(event.deviceStates);
                    if (available !== undefined)
                        void this.setShutterAvailable(shutter, available);
                    break;
                }
                case EventNames.deviceAvailable:
                case EventNames.deviceUnavailable: {
                    const shutter = event.deviceURL ? this.shutters.get(event.deviceURL) : undefined;
                    if (shutter)
                        void this.setShutterAvailable(shutter, event.name === EventNames.deviceAvailable);
                    break;
                }
                case EventNames.executionStateChanged:
                    for (const shutter of this.shutters.values())
                        shutter.controller.onExecutionState(event.execId, event.newState, event.failureType);
                    break;
                case EventNames.deviceCreated:
                case EventNames.deviceRemoved:
                case EventNames.deviceUpdated:
                    resync = true;
                    break;
            }
        }
        if (resync)
            this.session.requestResync();
        this.updateActivity();
    }

    /**
     * One line per event for the debug log, e.g.
     * `DeviceStateChangedEvent 'Kitchen' core:MovingState=false [1.25 s after stop]`.
     * The time since the command is measured when the event is received, so it includes the wait
     * for the next event query (up to a second while something moves). If an event carries the
     * time it happened on the box ("box …"; the TaHoma Switch did not send one in a test), that
     * time is used instead.
     */
    private describeEvent(event: TahomaEvent): string {
        const shutter = event.deviceURL ? this.shutters.get(event.deviceURL) : undefined;
        const parts: string[] = [event.name];
        if (event.deviceURL)
            parts.push(this.deviceName(event.deviceURL));
        if (event.execId)
            parts.push(event.execId);
        if (event.newState)
            parts.push(event.oldState ? `${event.oldState} -> ${event.newState}` : event.newState);
        if (event.failureType)
            parts.push(`(${event.failureType})`);
        if (Array.isArray(event.deviceStates) && event.deviceStates.length > 0)
            parts.push(event.deviceStates.map((state) => `${state?.name}=${formatValue(state?.value)}`).join(" "));
        const execution = event.execId ? this.executions.get(event.execId) : undefined;
        if (!execution && Array.isArray(event.actions)) {
            // Executions started elsewhere (TaHoma app, scenarios).
            parts.push(event.actions.map((action) => {
                const commands = Array.isArray(action?.commands) ? action.commands.map((command) => command?.name).join("+") : "?";
                return `${commands} ${this.deviceName(action?.deviceURL)}`;
            }).join(", "));
        }

        const notes: string[] = [];
        const at = eventTime(event);
        if (at !== undefined)
            notes.push(`box ${new Date(at).toISOString().substring(11, 23)}`);
        const command = execution ?? shutter?.lastCommand;
        const elapsed = command ? (at ?? this.clock.now()) - command.at : Number.NaN;
        if (command && (execution || elapsed < COMMAND_RELATION_MS))
            notes.push(`${(elapsed / 1000).toFixed(2)} s after ${command.description}`);
        return notes.length > 0 ? `${parts.join(" ")} [${notes.join(", ")}]` : parts.join(" ");
    }

    private deviceName(deviceURL: string | undefined): string {
        const shutter = deviceURL ? this.shutters.get(deviceURL) : undefined;
        return shutter ? `'${shutter.label}'` : String(deviceURL);
    }

    /** Updates the reachability; values are sent (again) once the device is reachable. */
    private async setShutterAvailable(shutter: ManagedShutter, available: boolean, publish = false): Promise<void> {
        const becameAvailable = available && !shutter.device.isAvailable;
        await shutter.device.setAvailable(available);
        if (available && (publish || becameAvailable))
            shutter.controller.publish();
    }

    private onOffline(error: Error): void {
        this.log.warn(`TaHoma not reachable (${errorMessage(error)}), roller shutters are shown as unreachable`);
        // All devices, also those created before a configuration change that this connection
        // has not taken over yet.
        this.syncChain = this.syncChain
            .then(async () => {
                const devices = await this.deps.devices.createdDevices();
                await Promise.all(devices.map((device) => device.setAvailable(false)));
            })
            .catch((failure) => this.log.error(`could not mark devices unreachable: ${errorMessage(failure)}`))
            .finally(() => this.emitStatus());
    }

    private tick(): void {
        for (const shutter of this.shutters.values())
            shutter.controller.tick();
        this.updateActivity();
    }

    private updateActivity(): void {
        let active = false;
        for (const shutter of this.shutters.values()) {
            if (shutter.controller.isMoving || shutter.controller.hasPendingCommand) {
                active = true;
                break;
            }
        }
        this.session.setActive(active);
    }

    private emitStatus(): void {
        if (!this.stopped)
            this.emit("status", this.status);
    }
}

function formatValue(value: unknown): string {
    return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Time of the event on the box, if it sent a plausible one. */
function eventTime(event: TahomaEvent): number | undefined {
    return typeof event.timestamp === "number" && event.timestamp > 1e12 ? event.timestamp : undefined;
}
