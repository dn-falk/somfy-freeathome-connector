import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { AddressInfo } from "node:net";

import { API_BASE_PATH } from "../../src/tahoma/client";
import { TahomaAction, TahomaDevice, TahomaEvent, TahomaState } from "../../src/tahoma/types";

export interface SimulatedShutterOptions {
    /** io node address, becomes the last part of the device URL. */
    id: string;
    label: string;
    position?: number;
    myPosition?: number;
    travelMs?: number;
    /** Report core:MovingState (default true). */
    movingState?: boolean;
    available?: boolean;
}

export interface SimulatorOptions {
    token?: string;
    pin?: string;
    shutters: SimulatedShutterOptions[];
    /** Resolution of the simulated movement. */
    tickMs?: number;
    /** Extra non-shutter devices returned by /setup/devices. */
    extraDevices?: TahomaDevice[];
    log?: (message: string) => void;
}

interface Shutter {
    deviceURL: string;
    label: string;
    position: number;
    target: number;
    myPosition: number;
    travelMs: number;
    movingState: boolean;
    available: boolean;
    moving: boolean;
    execId: string | undefined;
    timer: NodeJS.Timeout | undefined;
}

interface Execution {
    execId: string;
    actions: TahomaAction[];
    remaining: Set<string>;
    cancelled: boolean;
    finished: boolean;
}

export interface RecordedRequest {
    method: string;
    path: string;
    body: unknown;
    at: number;
}

const ROLLER_SHUTTER_COMMANDS = ["open", "close", "stop", "my", "setClosure", "up", "down", "identify", "wink"];

/**
 * In-memory simulation of the local API of a TaHoma Switch with io roller shutters.
 * Used by the tests and by `npm run mock` for development without a box.
 */
export class TahomaSimulator {
    readonly token: string;
    readonly pin: string;
    readonly requests: RecordedRequest[] = [];
    readonly executions: Execution[] = [];
    /** When set, every request fails with this HTTP status and body. */
    failure: { status: number; body: unknown } | undefined;
    /** When true, connections are closed without an answer. */
    unreachable = false;

    private readonly shutters = new Map<string, Shutter>();
    private readonly listeners = new Map<string, TahomaEvent[]>();
    private readonly tickMs: number;
    private server: http.Server | undefined;

    constructor(private readonly options: SimulatorOptions) {
        this.token = options.token ?? "test-token";
        this.pin = options.pin ?? "1234-5678-9012";
        this.tickMs = options.tickMs ?? 100;
        for (const shutter of options.shutters) {
            const deviceURL = this.deviceURL(shutter.id);
            const position = shutter.position ?? 0;
            this.shutters.set(deviceURL, {
                deviceURL,
                label: shutter.label,
                position,
                target: position,
                myPosition: shutter.myPosition ?? 50,
                travelMs: shutter.travelMs ?? 2_000,
                movingState: shutter.movingState ?? true,
                available: shutter.available ?? true,
                moving: false,
                execId: undefined,
                timer: undefined,
            });
        }
    }

    deviceURL(id: string): string {
        return `io://${this.pin}/${id}`;
    }

    async listen(port = 0, host = "127.0.0.1"): Promise<number> {
        this.server = http.createServer((req, res) => this.handle(req, res));
        await new Promise<void>((resolve) => this.server?.listen(port, host, resolve));
        return (this.server.address() as AddressInfo).port;
    }

    async close(): Promise<void> {
        for (const shutter of this.shutters.values()) {
            if (shutter.timer)
                clearInterval(shutter.timer);
        }
        const server = this.server;
        this.server = undefined;
        if (!server)
            return;
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    position(id: string): number {
        return Math.round(this.shutter(this.deviceURL(id)).position);
    }

    isMoving(id: string): boolean {
        return this.shutter(this.deviceURL(id)).moving;
    }

    /** Movement started outside of the addon, e.g. with a Somfy remote. */
    moveExternally(id: string, target: number): void {
        this.startMovement(this.shutter(this.deviceURL(id)), target, undefined);
    }

    setAvailable(id: string, available: boolean): void {
        const shutter = this.shutter(this.deviceURL(id));
        shutter.available = available;
        this.publish({
            name: available ? "DeviceAvailableEvent" : "DeviceUnavailableEvent",
            deviceURL: shutter.deviceURL,
        });
        this.publish({
            name: "DeviceStateChangedEvent",
            deviceURL: shutter.deviceURL,
            deviceStates: [{ name: "core:StatusState", type: 3, value: available ? "available" : "unavailable" }],
        });
    }

    /** Simulates a reboot of the box: all event listeners become invalid. */
    dropListeners(): void {
        this.listeners.clear();
    }

    commandsSent(): { deviceURL: string; name: string; parameters?: unknown[] }[] {
        return this.executions.flatMap((execution) => execution.actions.flatMap((action) =>
            action.commands.map((command) => ({ deviceURL: action.deviceURL, name: command.name, parameters: command.parameters }))));
    }

    devices(): TahomaDevice[] {
        const shutters = [...this.shutters.values()].map((shutter): TahomaDevice => ({
            deviceURL: shutter.deviceURL,
            label: shutter.label,
            available: shutter.available,
            enabled: true,
            controllableName: "io:RollerShutterGenericIOComponent",
            definition: {
                uiClass: "RollerShutter",
                widgetName: "PositionableRollerShutter",
                commands: ROLLER_SHUTTER_COMMANDS.map((commandName) => ({ commandName, nparams: commandName === "setClosure" ? 1 : 0 })),
                states: [
                    { name: "core:ClosureState" },
                    { name: "core:TargetClosureState" },
                    { name: "core:StatusState" },
                    { name: "core:Memorized1PositionState" },
                    ...(shutter.movingState ? [{ name: "core:MovingState" }] : []),
                ],
            },
            states: this.states(shutter),
        }));
        return [...shutters, ...(this.options.extraDevices ?? [])];
    }

    private states(shutter: Shutter): TahomaState[] {
        return [
            { name: "core:ClosureState", type: 1, value: Math.round(shutter.position) },
            { name: "core:TargetClosureState", type: 1, value: Math.round(shutter.target) },
            { name: "core:OpenClosedState", type: 3, value: shutter.position >= 100 ? "closed" : "open" },
            { name: "core:StatusState", type: 3, value: shutter.available ? "available" : "unavailable" },
            { name: "core:Memorized1PositionState", type: 1, value: shutter.myPosition },
            ...(shutter.movingState ? [{ name: "core:MovingState", type: 6, value: shutter.moving }] : []),
        ];
    }

    private shutter(deviceURL: string): Shutter {
        const shutter = this.shutters.get(deviceURL);
        if (!shutter)
            throw new Error(`unknown shutter ${deviceURL}`);
        return shutter;
    }

    private log(message: string): void {
        this.options.log?.(message);
    }

    private publish(event: TahomaEvent): void {
        for (const queue of this.listeners.values())
            queue.push({ timestamp: Date.now(), ...event });
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            if (this.unreachable) {
                req.socket.destroy();
                return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown;
            try {
                body = text ? JSON.parse(text) : undefined;
            } catch {
                body = text;
            }
            const path = (req.url ?? "").replace(API_BASE_PATH, "");
            this.requests.push({ method: req.method ?? "", path, body, at: Date.now() });
            const send = (status: number, payload?: unknown) => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(payload === undefined ? "" : JSON.stringify(payload));
            };

            if (this.failure) {
                send(this.failure.status, this.failure.body);
                return;
            }
            if (!req.url?.startsWith(API_BASE_PATH)) {
                send(404, { error: "Not found", errorCode: "RESOURCE_NOT_FOUND" });
                return;
            }
            if (path !== "/apiVersion" && req.headers.authorization !== `Bearer ${this.token}`) {
                send(401, { error: "Not authenticated.", errorCode: "RESOURCE_ACCESS_DENIED" });
                return;
            }
            this.route(req.method ?? "GET", path, body, send);
        });
    }

    private route(method: string, path: string, body: unknown, send: (status: number, payload?: unknown) => void): void {
        if (method === "GET" && path === "/apiVersion")
            return send(200, { protocolVersion: "2026.3.4-12" });
        if (method === "GET" && path === "/setup/devices")
            return send(200, this.devices());
        if (method === "GET" && path === "/setup/gateways")
            return send(200, [{ gatewayId: this.pin, connectivity: { status: "OK", protocolVersion: "2026.3.4-12" } }]);
        if (method === "POST" && path === "/events/register") {
            const id = randomUUID();
            this.listeners.set(id, []);
            return send(200, { id });
        }
        const fetch = /^\/events\/([^/]+)\/(fetch|unregister)$/.exec(path);
        if (method === "POST" && fetch) {
            const id = decodeURIComponent(fetch[1]);
            const queue = this.listeners.get(id);
            if (!queue)
                return send(400, { error: `Invalid event listener id : ${id}`, errorCode: "UNSPECIFIED_ERROR" });
            if (fetch[2] === "unregister") {
                this.listeners.delete(id);
                return send(200, []);
            }
            this.listeners.set(id, []);
            return send(200, queue);
        }
        if (method === "POST" && path === "/exec/apply")
            return this.apply(body, send);
        return send(404, { error: "Unknown object.", errorCode: "UNSPECIFIED_ERROR" });
    }

    private apply(body: unknown, send: (status: number, payload?: unknown) => void): void {
        const actions = (body as { actions?: TahomaAction[] } | undefined)?.actions;
        if (!Array.isArray(actions) || actions.length === 0)
            return send(400, { error: "Malformed \"Malformed action group\". (missing parameter)", errorCode: "MISSING_PARAMETERS" });
        const seen = new Set<string>();
        for (const action of actions) {
            if (seen.has(action.deviceURL))
                return send(400, { error: `Another action exists on the same device : ${action.deviceURL}`, errorCode: "DUPLICATE_FIELD_OR_VALUE" });
            seen.add(action.deviceURL);
            if (!this.shutters.has(action.deviceURL))
                return send(400, { error: `No such device : "${action.deviceURL}"`, errorCode: "NO_SUCH_DEVICE" });
        }

        const execution: Execution = { execId: randomUUID(), actions, remaining: new Set(), cancelled: false, finished: false };
        this.executions.push(execution);
        send(200, { execId: execution.execId });

        this.publish({ name: "ExecutionRegisteredEvent", execId: execution.execId, actions });
        this.publish({ name: "ExecutionStateChangedEvent", execId: execution.execId, newState: "IN_PROGRESS", oldState: "INITIALIZED" });
        for (const action of actions) {
            const shutter = this.shutter(action.deviceURL);
            for (const command of action.commands)
                this.execute(shutter, command.name, command.parameters, execution);
        }
        this.finishIfDone(execution);
    }

    private execute(shutter: Shutter, name: string, parameters: unknown[] | undefined, execution: Execution): void {
        this.log(`${shutter.label}: ${name}${parameters?.length ? `(${parameters.join(", ")})` : ""}`);
        switch (name) {
            case "open":
            case "up":
                return this.startMovement(shutter, 0, execution);
            case "close":
            case "down":
                return this.startMovement(shutter, 100, execution);
            case "setClosure":
                return this.startMovement(shutter, Number(parameters?.[0] ?? 0), execution);
            case "my":
                return this.startMovement(shutter, shutter.myPosition, execution);
            case "stop":
                return this.stopMovement(shutter);
            default:
                return;
        }
    }

    private startMovement(shutter: Shutter, target: number, execution: Execution | undefined): void {
        this.cancelExecution(shutter);
        if (execution) {
            shutter.execId = execution.execId;
            execution.remaining.add(shutter.deviceURL);
        }
        shutter.target = Math.min(100, Math.max(0, target));
        if (Math.round(shutter.position) === shutter.target) {
            this.endMovement(shutter);
            return;
        }
        const wasMoving = shutter.moving;
        shutter.moving = true;
        this.publish({
            name: "DeviceStateChangedEvent",
            deviceURL: shutter.deviceURL,
            deviceStates: [
                { name: "core:TargetClosureState", type: 1, value: shutter.target },
                ...(shutter.movingState && !wasMoving ? [{ name: "core:MovingState", type: 6, value: true }] : []),
            ],
        });
        if (shutter.timer)
            clearInterval(shutter.timer);
        const step = 100 * this.tickMs / shutter.travelMs;
        shutter.timer = setInterval(() => {
            const delta = shutter.target - shutter.position;
            if (Math.abs(delta) <= step) {
                shutter.position = shutter.target;
                this.endMovement(shutter);
                return;
            }
            shutter.position += Math.sign(delta) * step;
        }, this.tickMs);
    }

    private stopMovement(shutter: Shutter): void {
        if (!shutter.moving)
            return;
        this.cancelExecution(shutter);
        shutter.position = Math.round(shutter.position);
        shutter.target = shutter.position;
        this.endMovement(shutter);
    }

    private endMovement(shutter: Shutter): void {
        if (shutter.timer)
            clearInterval(shutter.timer);
        shutter.timer = undefined;
        const wasMoving = shutter.moving;
        shutter.moving = false;
        this.publish({
            name: "DeviceStateChangedEvent",
            deviceURL: shutter.deviceURL,
            deviceStates: [
                { name: "core:ClosureState", type: 1, value: Math.round(shutter.position) },
                { name: "core:OpenClosedState", type: 3, value: shutter.position >= 100 ? "closed" : "open" },
                ...(shutter.movingState && wasMoving ? [{ name: "core:MovingState", type: 6, value: false }] : []),
            ],
        });
        const execution = this.executions.find((candidate) => candidate.execId === shutter.execId);
        shutter.execId = undefined;
        if (execution) {
            execution.remaining.delete(shutter.deviceURL);
            this.finishIfDone(execution);
        }
    }

    private cancelExecution(shutter: Shutter): void {
        const execution = this.executions.find((candidate) => candidate.execId === shutter.execId);
        shutter.execId = undefined;
        if (!execution)
            return;
        execution.remaining.delete(shutter.deviceURL);
        execution.cancelled = true;
        this.finishIfDone(execution);
    }

    private finishIfDone(execution: Execution): void {
        if (execution.remaining.size > 0 || execution.finished)
            return;
        execution.finished = true;
        this.publish({
            name: "ExecutionStateChangedEvent",
            execId: execution.execId,
            oldState: "IN_PROGRESS",
            newState: execution.cancelled ? "FAILED" : "COMPLETED",
            ...(execution.cancelled ? { failureType: "CMDCANCELLED" } : {}),
        });
    }
}
