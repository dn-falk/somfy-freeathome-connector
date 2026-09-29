import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";

import { Logger } from "../src/log";
import { API_BASE_PATH, TahomaClient, TahomaClientOptions } from "../src/tahoma/client";
import { TahomaError } from "../src/tahoma/errors";
import { TahomaSimulator } from "./support/tahomaSimulator";

Logger.silent = true;

async function listen(server: http.Server | https.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server | https.Server): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("TahomaClient (HTTP)", () => {
    let simulator: TahomaSimulator;
    let port: number;
    const clients: TahomaClient[] = [];

    const client = (overrides: Partial<TahomaClientOptions> = {}) => {
        const instance = new TahomaClient({
            host: "127.0.0.1", port, token: simulator.token, verifyCertificate: true, insecureHttp: true, ...overrides,
        });
        clients.push(instance);
        return instance;
    };

    before(async () => {
        simulator = new TahomaSimulator({ shutters: [{ id: "1", label: "Küche", position: 20 }] });
        port = await simulator.listen();
    });

    after(async () => {
        clients.forEach((instance) => instance.close());
        await simulator.close();
    });

    it("reads version and devices", async () => {
        const api = client();
        assert.equal((await api.getApiVersion()).protocolVersion, "2026.3.4-12");
        const devices = await api.getDevices();
        assert.equal(devices.length, 1);
        assert.equal(devices[0].label, "Küche");
        const request = simulator.requests.find((entry) => entry.path === "/setup/devices");
        assert.ok(request);
    });

    it("executes commands and returns the execution id", async () => {
        const api = client();
        const execId = await api.execute([{ deviceURL: simulator.deviceURL("1"), commands: [{ name: "setClosure", parameters: [60] }] }], "free@home");
        assert.match(execId, /^[0-9a-f-]{36}$/);
        const request = simulator.requests[simulator.requests.length - 1];
        assert.equal(request.method, "POST");
        assert.equal(request.path, "/exec/apply");
        assert.deepEqual(request.body, {
            label: "free@home",
            actions: [{ deviceURL: simulator.deviceURL("1"), commands: [{ name: "setClosure", parameters: [60] }] }],
        });
    });

    it("registers a listener and fetches events", async () => {
        const api = client();
        const listenerId = await api.registerEventListener();
        await api.execute([{ deviceURL: simulator.deviceURL("1"), commands: [{ name: "open" }] }], "test");
        const events = await api.fetchEvents(listenerId);
        assert.ok(events.some((event) => event.name === "ExecutionRegisteredEvent"));
        assert.ok(events.some((event) => event.name === "DeviceStateChangedEvent"));
        assert.deepEqual(await api.fetchEvents(listenerId), []);
        await api.unregisterEventListener(listenerId);
        await assert.rejects(api.fetchEvents(listenerId), (error: TahomaError) => error.kind === "invalidListener");
    });

    it("logs requests in the debug log, routine event queries only if they fail or are slow", async () => {
        const lines: string[] = [];
        mock.method(console, "log", (line: unknown) => lines.push(String(line)));
        Logger.silent = false;
        Logger.debugEnabled = true;
        try {
            const api = client();
            const listenerId = await api.registerEventListener();
            await api.fetchEvents(listenerId);
            await api.getDevices();
            await assert.rejects(api.fetchEvents("unknown-listener"));
        } finally {
            mock.restoreAll();
            Logger.silent = true;
            Logger.debugEnabled = false;
        }
        assert.ok(lines.some((line) => /POST \/events\/register -> 200 \(\d+ ms\)$/.test(line)));
        assert.ok(lines.some((line) => /GET \/setup\/devices -> 200 \(\d+ ms\)$/.test(line)));
        const fetches = lines.filter((line) => line.includes("/fetch"));
        assert.equal(fetches.length, 1, "only the failed event query");
        assert.match(fetches[0], /POST \/events\/unknown-listener\/fetch -> 400 \(\d+ ms\)$/);
    });

    it("reports a wrong token as auth error", async () => {
        await assert.rejects(client({ token: "wrong" }).getDevices(),
            (error: TahomaError) => error.kind === "auth" && error.status === 401);
    });

    it("reports API errors", async () => {
        await assert.rejects(client().execute([{ deviceURL: "io://1234-5678-9012/404", commands: [{ name: "open" }] }], "x"),
            (error: TahomaError) => error.kind === "api" && error.errorCode === "NO_SUCH_DEVICE");
    });

    it("reports refused connections as network errors", async () => {
        const server = http.createServer();
        const freePort = await listen(server);
        await closeServer(server);
        await assert.rejects(client({ port: freePort }).getApiVersion(), (error: TahomaError) => error.kind === "network");
    });

    it("times out", async () => {
        const server = http.createServer(() => { /* never answers */ });
        const slowPort = await listen(server);
        try {
            await assert.rejects(client({ port: slowPort, requestTimeoutMs: 100 }).getApiVersion(),
                (error: TahomaError) => error.kind === "timeout");
        } finally {
            await closeServer(server);
        }
    });

    it("reuses connections and repeats requests on connections closed by the box", async () => {
        let connections = 0;
        let requests = 0;
        let dropped = false;
        const server = http.createServer((req, res) => {
            requests++;
            const socket = req.socket as typeof req.socket & { served?: number };
            socket.served = (socket.served ?? 0) + 1;
            // The box closes an idle keep-alive connection: the second request on it gets no answer.
            if (socket.served === 2 && !dropped) {
                dropped = true;
                socket.destroy();
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ protocolVersion: "1" }));
        });
        server.on("connection", () => connections++);
        const serverPort = await listen(server);
        try {
            const api = client({ port: serverPort });
            await api.getApiVersion();
            await api.getApiVersion();
            assert.equal(requests, 3);
            assert.equal(connections, 2);
            await api.getApiVersion();
            assert.equal(connections, 2, "keep-alive connection is reused");
        } finally {
            await closeServer(server);
        }
    });

    it("sends the bearer token", async () => {
        let authorization: string | undefined;
        const server = http.createServer((req, res) => {
            authorization = req.headers.authorization;
            res.end("[]");
        });
        const serverPort = await listen(server);
        try {
            await client({ port: serverPort, token: "abc" }).getDevices();
            assert.equal(authorization, "Bearer abc");
            assert.ok(API_BASE_PATH.startsWith("/enduser-mobile-web"));
        } finally {
            await closeServer(server);
        }
    });
});

function hasOpenssl(): boolean {
    try {
        execFileSync("openssl", ["version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

describe("TahomaClient (TLS)", { skip: !hasOpenssl() && "openssl not available" }, () => {
    const pin = "1234-5678-9012";
    let dir: string;
    let server: https.Server;
    let port: number;
    let ca: string;
    const clients: TahomaClient[] = [];

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), "tahoma-tls-"));
        const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
        run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/O=Test/CN=Test Root CA");
        run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "gw.key", "-out", "gw.csr", "-subj", `/CN=gateway-${pin}.local`);
        writeFileSync(join(dir, "ext.cnf"), `subjectAltName=DNS:gateway-${pin}.local\n`);
        run("x509", "-req", "-in", "gw.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "gw.crt", "-days", "2", "-extfile", "ext.cnf");
        ca = readFileSync(join(dir, "ca.crt"), "utf8");

        server = https.createServer({ key: readFileSync(join(dir, "gw.key")), cert: readFileSync(join(dir, "gw.crt")) }, (_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ protocolVersion: "tls" }));
        });
        port = await listen(server);
    });

    after(async () => {
        clients.forEach((instance) => instance.close());
        await closeServer(server);
        rmSync(dir, { recursive: true, force: true });
    });

    const client = (options: Partial<TahomaClientOptions>) => {
        const instance = new TahomaClient({ host: "127.0.0.1", port, token: "t", verifyCertificate: true, ...options });
        clients.push(instance);
        return instance;
    };

    it("accepts a certificate of the trusted CA when connecting by IP", async () => {
        assert.equal((await client({ ca }).getApiVersion()).protocolVersion, "tls");
    });

    it("checks the host name against the gateway PIN", async () => {
        assert.equal((await client({ ca, gatewayPin: pin }).getApiVersion()).protocolVersion, "tls");
        await assert.rejects(client({ ca, gatewayPin: "9999-9999-9999" }).getApiVersion(),
            (error: TahomaError) => error.kind === "network" && /gateway-9999-9999-9999\.local/.test(error.message));
    });

    it("rejects certificates that are not issued by the Overkiz CA", async () => {
        await assert.rejects(client({}).getApiVersion(), (error: TahomaError) => error.kind === "network");
    });

    it("can skip the certificate check", async () => {
        assert.equal((await client({ verifyCertificate: false }).getApiVersion()).protocolVersion, "tls");
    });
});
