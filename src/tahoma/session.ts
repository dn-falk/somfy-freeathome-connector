import { EventEmitter } from "node:events";

import { Logger, errorMessage } from "../log";
import { TahomaApi } from "./client";
import { TahomaError } from "./errors";
import { TahomaDevice, TahomaEvent } from "./types";

export interface SessionOptions {
    /** Event fetch interval while nothing is moving. */
    idleIntervalMs: number;
    /** Event fetch interval while a shutter moves (Somfy recommends at most once per second). */
    activeIntervalMs: number;
    /** Waiting times between reconnection attempts (last value is repeated). */
    retryDelaysMs?: number[];
    /** Waiting time after the box rejected the token. */
    authRetryDelayMs?: number;
}

export interface SetupInfo {
    protocolVersion: string;
    devices: TahomaDevice[];
}

export type SessionState = "stopped" | "connecting" | "online" | "offline";

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const AUTH_RETRY_DELAY_MS = 30_000;
const UNREGISTER_TIMEOUT_MS = 2_000;
const STOP_WAIT_MS = 1_500;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export declare interface GatewaySession {
    /** Complete device list after (re)connecting or after a resync. */
    on(event: "setup", listener: (info: SetupInfo) => void): this;
    on(event: "events", listener: (events: TahomaEvent[]) => void): this;
    /** The box is not reachable or rejects the token. */
    on(event: "offline", listener: (error: Error) => void): this;
}

/**
 * Keeps the connection to the box alive: registers an event listener, fetches events
 * periodically (fast while something moves), re-registers after a reboot of the box and
 * reconnects with backoff when the box is not reachable.
 *
 * Commands are not sent through the session; they use the client directly and therefore
 * never wait for a fetch cycle.
 */
export class GatewaySession extends EventEmitter {
    private currentState: SessionState = "stopped";
    private listenerId: string | undefined;
    private running = false;
    private active = false;
    private resyncRequested = false;
    private failures = 0;
    private wake: (() => void) | undefined;
    private loopPromise: Promise<void> | undefined;
    private error: Error | undefined;
    private version: string | undefined;

    constructor(
        private readonly api: TahomaApi,
        private readonly options: SessionOptions,
        private readonly log = new Logger("session"),
    ) {
        super();
    }

    get state(): SessionState {
        return this.currentState;
    }

    get lastError(): Error | undefined {
        return this.error;
    }

    get protocolVersion(): string | undefined {
        return this.version;
    }

    start(): void {
        if (this.running)
            return;
        this.running = true;
        this.currentState = "connecting";
        this.loopPromise = this.loop();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.wake?.();
        // Do not wait for a running fetch (up to its timeout); the loop ends after it anyway.
        await Promise.race([this.loopPromise, delay(STOP_WAIT_MS)]);
        this.currentState = "stopped";
        const listenerId = this.listenerId;
        this.listenerId = undefined;
        if (listenerId) {
            await Promise.race([
                this.api.unregisterEventListener(listenerId).catch(() => undefined),
                delay(UNREGISTER_TIMEOUT_MS),
            ]);
        }
    }

    /** Switches to fast polling while shutters move; fetches immediately when activated. */
    setActive(active: boolean): void {
        const wasActive = this.active;
        this.active = active;
        if (active && !wasActive)
            this.wake?.();
    }

    /** Reads the device list again (e.g. after devices were added in the TaHoma app). */
    requestResync(): void {
        this.resyncRequested = true;
        this.wake?.();
    }

    private async loop(): Promise<void> {
        while (this.running) {
            try {
                if (!this.listenerId)
                    await this.connect();
                else if (this.resyncRequested)
                    await this.resync();

                const events = await this.api.fetchEvents(this.listenerId as string);
                if (!this.running)
                    break;
                this.failures = 0;
                if (events.length > 0)
                    this.safeEmit("events", events);
                await this.sleep(this.active ? this.options.activeIntervalMs : this.options.idleIntervalMs);
            } catch (error) {
                if (!this.running)
                    break;
                await this.handleError(error);
            }
        }
    }

    private async connect(): Promise<void> {
        const version = await this.api.getApiVersion();
        // Register first, so that no change between reading the devices and the first fetch is lost.
        this.listenerId = await this.api.registerEventListener();
        const devices = await this.api.getDevices();
        this.api.warmUp();

        this.version = version?.protocolVersion;
        this.failures = 0;
        this.error = undefined;
        this.resyncRequested = false;
        if (this.currentState !== "online")
            this.log.info(`connected to TaHoma (protocol ${this.version ?? "unknown"}), ${devices.length} devices`);
        this.currentState = "online";
        this.safeEmit("setup", { protocolVersion: this.version ?? "", devices });
    }

    private async resync(): Promise<void> {
        this.resyncRequested = false;
        const devices = await this.api.getDevices();
        this.safeEmit("setup", { protocolVersion: this.version ?? "", devices });
    }

    private async handleError(error: unknown): Promise<void> {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err instanceof TahomaError && err.kind === "invalidListener") {
            // Listener expired or the box rebooted: register a new one and read all states again.
            this.log.info("event listener is no longer valid, registering a new one");
            this.listenerId = undefined;
            return;
        }

        this.listenerId = undefined;
        this.failures++;
        this.error = err;
        const isAuthError = err instanceof TahomaError && err.kind === "auth";
        if ((isAuthError || this.failures >= 2) && this.currentState !== "offline") {
            this.currentState = "offline";
            this.log.warn(`TaHoma not available: ${errorMessage(err)}`);
            this.safeEmit("offline", err);
        } else {
            this.log.debug(`request failed (${this.failures}): ${errorMessage(err)}`);
        }
        const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
        const retryInMs = isAuthError
            ? this.options.authRetryDelayMs ?? AUTH_RETRY_DELAY_MS
            : delays[Math.min(this.failures - 1, delays.length - 1)];
        await this.sleep(retryInMs);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            if (!this.running) {
                resolve();
                return;
            }
            const done = () => {
                clearTimeout(timer);
                this.wake = undefined;
                resolve();
            };
            const timer = setTimeout(done, ms);
            this.wake = done;
        });
    }

    private safeEmit(event: string, payload: unknown): void {
        try {
            this.emit(event, payload);
        } catch (error) {
            this.log.error(`error while handling "${event}": ${errorMessage(error)}`, error);
        }
    }
}
