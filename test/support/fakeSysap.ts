import * as http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import { PairingId } from "../../src/fah/datapoints";

const SYSAP = "00000000-0000-0000-0000-000000000000";

/** Channel layout of a virtual BlindActuator as reported by the System Access Point. */
const BLIND_INPUTS = [
    PairingId.AL_MOVE_UP_DOWN,
    PairingId.AL_STOP_STEP_UP_DOWN,
    PairingId.AL_SET_ABSOLUTE_POSITION_BLINDS_PERCENTAGE,
    PairingId.AL_FORCED_UP_DOWN,
    PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE,
];
const BLIND_OUTPUTS = [
    PairingId.AL_INFO_MOVE_UP_DOWN,
    PairingId.AL_CURRENT_ABSOLUTE_POSITION_BLINDS_PERCENTAGE,
    PairingId.AL_INFO_FORCE,
    0x0111, // AL_INFO_ERROR
];

interface VirtualDevice {
    serial: string;
    nativeId: string;
    type: string;
    displayName?: string;
    ttl: string;
    outputs: Map<number, string>;
}

const hex = (value: number) => value.toString(16).padStart(4, "0");

/**
 * Minimal fake of the local API of a System Access Point (virtual devices, datapoints,
 * websocket, addon configuration/events/application state and the addon RPC websocket).
 * Lets the tests run the real addon (build/main.js with the real free@home library).
 */
export class FakeSysap {
    readonly devices = new Map<string, VirtualDevice>();
    readonly applicationStates: unknown[] = [];
    readonly virtualDeviceCalls: { nativeId: string; body: { type: string; properties?: Record<string, string> } }[] = [];
    private readonly server = http.createServer((req, res) => this.handle(req, res));
    private readonly wss = new WebSocketServer({ noServer: true });
    private readonly fhSockets = new Set<WebSocket>();
    private rpcSocket: WebSocket | undefined;
    private readonly sseClients = new Map<string, http.ServerResponse[]>();
    private configuration: unknown;
    private nextSerial = 0x6000_0000_0001;
    private rpcId = 0;
    private readonly rpcWaiters = new Map<number, (result: unknown) => void>();

    constructor(private readonly addonId: string) {
        this.server.on("upgrade", (req, socket, head) => {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                if (req.url === "/api/fhapi/v1/api/ws") {
                    this.fhSockets.add(ws);
                    ws.on("close", () => this.fhSockets.delete(ws));
                } else if (req.url === `/api/rpc/v1/${this.addonId}/websocket`) {
                    this.rpcSocket = ws;
                    ws.on("message", (data) => {
                        const message = JSON.parse(data.toString()) as { id: number; result?: unknown; error?: unknown };
                        this.rpcWaiters.get(message.id)?.(message.result ?? message.error);
                    });
                } else {
                    ws.close();
                }
            });
        });
    }

    async listen(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async close(): Promise<void> {
        for (const clients of this.sseClients.values())
            clients.forEach((client) => client.end());
        this.wss.clients.forEach((client) => client.terminate());
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    /** Sends a new addon configuration (like saving the addon settings in the app). */
    setConfiguration(configuration: unknown): void {
        this.configuration = configuration;
        for (const client of this.sseClients.get("configuration") ?? [])
            client.write(`data: ${JSON.stringify(configuration)}\n\n`);
    }

    /** A push button / the app writes an input datapoint of a virtual device. */
    input(nativeId: string, pairingId: number, value: string): void {
        const device = this.device(nativeId);
        const index = BLIND_INPUTS.indexOf(pairingId as typeof BLIND_INPUTS[number]);
        if (index < 0)
            throw new Error(`no input for pairing id ${pairingId}`);
        this.broadcast({ datapoints: { [`${device.serial}/ch0000/idp${hex(index)}`]: value } });
    }

    output(nativeId: string, pairingId: number): string | undefined {
        return this.devices.get(nativeId)?.outputs.get(pairingId);
    }

    rpc(method: string, params: unknown): Promise<unknown> {
        const socket = this.rpcSocket;
        if (!socket)
            return Promise.reject(new Error("addon RPC not connected"));
        const id = ++this.rpcId;
        return new Promise((resolve) => {
            this.rpcWaiters.set(id, resolve);
            socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }

    get rpcConnected(): boolean {
        return this.rpcSocket?.readyState === WebSocket.OPEN;
    }

    device(nativeId: string): VirtualDevice {
        const device = this.devices.get(nativeId);
        if (!device)
            throw new Error(`virtual device ${nativeId} not created`);
        return device;
    }

    private broadcast(content: Record<string, unknown>): void {
        const message = JSON.stringify({
            [SYSAP]: { datapoints: {}, devices: {}, devicesAdded: [], devicesRemoved: [], scenesTriggered: {}, ...content },
        });
        this.fhSockets.forEach((socket) => socket.send(message));
    }

    private channelDescription(device: VirtualDevice) {
        return {
            displayName: device.displayName,
            functionID: "61",
            inputs: Object.fromEntries(BLIND_INPUTS.map((pairingID, index) => [`idp${hex(index)}`, { pairingID, value: "0" }])),
            outputs: Object.fromEntries(BLIND_OUTPUTS.map((pairingID, index) => [`odp${hex(index)}`, { pairingID, value: "0" }])),
        };
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const url = req.url ?? "";
            const json = (status: number, payload: unknown) => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(payload));
            };

            // ---- addon (scripting) API
            const container = /^\/api\/scripting\/v1\/rest\/container\/([^/]+)\/(configuration|events|applicationstate)$/.exec(url);
            if (container) {
                if (req.method === "GET") {
                    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
                    const list = this.sseClients.get(container[2]) ?? [];
                    list.push(res);
                    this.sseClients.set(container[2], list);
                    if (container[2] === "configuration" && this.configuration !== undefined)
                        res.write(`data: ${JSON.stringify(this.configuration)}\n\n`);
                    return;
                }
                if (req.method === "PUT" && container[2] === "applicationstate") {
                    this.applicationStates.push(JSON.parse(body));
                    return json(200, {});
                }
                return json(200, {});
            }

            // ---- local API: virtual devices
            const virtualDevice = /^\/api\/fhapi\/v1\/api\/rest\/virtualdevice\/([^/]+)\/([^/]+)$/.exec(url);
            if (virtualDevice && req.method === "PUT") {
                const nativeId = decodeURIComponent(virtualDevice[2]);
                const request = JSON.parse(body) as { type: string; properties?: Record<string, string> };
                this.virtualDeviceCalls.push({ nativeId, body: request });
                let device = this.devices.get(nativeId);
                if (!device) {
                    device = {
                        serial: (this.nextSerial++).toString(16).toUpperCase().padStart(12, "0"),
                        nativeId,
                        type: request.type,
                        displayName: request.properties?.displayname,
                        ttl: request.properties?.ttl ?? "180",
                        outputs: new Map(),
                    };
                    this.devices.set(nativeId, device);
                }
                device.ttl = request.properties?.ttl ?? device.ttl;
                return json(200, { [SYSAP]: { devices: { [device.serial]: { serial: nativeId } } } });
            }

            const getDevice = /^\/api\/fhapi\/v1\/api\/rest\/device\/([^/]+)\/([^/]+)$/.exec(url);
            if (getDevice && req.method === "GET") {
                const device = [...this.devices.values()].find((candidate) => candidate.serial === getDevice[2]);
                if (!device)
                    return json(404, {});
                return json(200, { [SYSAP]: { devices: { [device.serial]: { channels: { ch0000: this.channelDescription(device) } } } } });
            }

            const datapoint = /^\/api\/fhapi\/v1\/api\/rest\/datapoint\/([^/]+)\/([0-9A-F]+)\.ch0000\.odp([0-9a-f]{4})$/i.exec(url);
            if (datapoint && req.method === "PUT") {
                const device = [...this.devices.values()].find((candidate) => candidate.serial === datapoint[2]);
                const pairingId = BLIND_OUTPUTS[parseInt(datapoint[3], 16)];
                if (!device || pairingId === undefined)
                    return json(404, {});
                device.outputs.set(pairingId, body);
                return json(200, { [SYSAP]: { values: [body] } });
            }

            return json(404, { error: `not implemented: ${req.method} ${url}` });
        });
    }
}
