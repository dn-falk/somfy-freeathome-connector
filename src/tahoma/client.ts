import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";

import { Logger } from "../log";
import { TahomaError, apiError, isStaleSocketError } from "./errors";
import { OVERKIZ_ROOT_CA } from "./overkizCa";
import { ApiVersion, TahomaAction, TahomaDevice, TahomaEvent } from "./types";

export const API_BASE_PATH = "/enduser-mobile-web/1/enduserAPI";

export interface TahomaClientOptions {
    host: string;
    port: number;
    token: string;
    /** PIN of the box (1234-5678-9012); used to check the host name of the certificate. */
    gatewayPin?: string;
    /** Verify the certificate chain against the Overkiz root CA. */
    verifyCertificate: boolean;
    /** Plain HTTP instead of HTTPS. Only for development with the mock server. */
    insecureHttp?: boolean;
    /** Timeout for commands and setup requests. */
    requestTimeoutMs?: number;
    /** Trusted root certificate; defaults to the Overkiz root CA (other values are for tests). */
    ca?: string;
}

/** Subset of the client used by the rest of the addon (allows fakes in tests). */
export interface TahomaApi {
    getApiVersion(): Promise<ApiVersion>;
    getDevices(): Promise<TahomaDevice[]>;
    execute(actions: TahomaAction[], label: string): Promise<string>;
    registerEventListener(): Promise<string>;
    fetchEvents(listenerId: string): Promise<TahomaEvent[]>;
    unregisterEventListener(listenerId: string): Promise<void>;
    warmUp(): void;
    close(): void;
}

type Method = "GET" | "POST" | "DELETE";

const DEFAULT_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;

export function gatewayHostname(gatewayPin: string): string {
    return `gateway-${gatewayPin}.local`;
}

/**
 * TLS options for the local API. The box presents a certificate of the Overkiz root CA
 * issued for `gateway-<pin>.local`. As the addon usually connects by IP address (mDNS names
 * are not resolvable inside the addon container), the host name is only checked against the
 * PIN if one is configured.
 */
export function createTlsOptions(options: Pick<TahomaClientOptions, "gatewayPin" | "verifyCertificate" | "ca">): https.AgentOptions {
    if (!options.verifyCertificate)
        return { rejectUnauthorized: false };

    const expectedHost = options.gatewayPin ? gatewayHostname(options.gatewayPin) : undefined;
    return {
        ca: options.ca ?? OVERKIZ_ROOT_CA,
        rejectUnauthorized: true,
        ...(expectedHost ? { servername: expectedHost } : {}),
        checkServerIdentity: (_host: string, cert: tls.PeerCertificate) =>
            expectedHost ? tls.checkServerIdentity(expectedHost, cert) : undefined,
    };
}

/**
 * HTTP client for the local API of a TaHoma Switch.
 *
 * Latency matters for push buttons, so all requests share one keep-alive agent. Sockets are
 * used round robin ("fifo") and {@link warmUp} opens a second socket, so a command normally
 * finds an idle, already established TLS connection even while an event fetch is in flight.
 */
export class TahomaClient implements TahomaApi {
    private readonly agent: http.Agent;
    private readonly transport: typeof http | typeof https;
    private readonly timeoutMs: number;

    constructor(private readonly options: TahomaClientOptions, private readonly log = new Logger("tahoma")) {
        this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        const agentOptions: http.AgentOptions = {
            keepAlive: true,
            keepAliveMsecs: 10_000,
            maxSockets: 4,
            scheduling: "fifo",
        };
        if (options.insecureHttp) {
            this.transport = http;
            this.agent = new http.Agent(agentOptions);
        } else {
            this.transport = https;
            this.agent = new https.Agent({ ...agentOptions, ...createTlsOptions(options) });
        }
    }

    getApiVersion(): Promise<ApiVersion> {
        return this.request<ApiVersion>("GET", "/apiVersion");
    }

    getDevices(): Promise<TahomaDevice[]> {
        return this.request<TahomaDevice[]>("GET", "/setup/devices", undefined, FETCH_TIMEOUT_MS);
    }

    async execute(actions: TahomaAction[], label: string): Promise<string> {
        const result = await this.request<{ execId?: string }>("POST", "/exec/apply", { label, actions });
        if (!result?.execId)
            throw new TahomaError("exec/apply returned no execId", "api");
        return result.execId;
    }

    async registerEventListener(): Promise<string> {
        const result = await this.request<{ id?: string }>("POST", "/events/register");
        if (!result?.id)
            throw new TahomaError("events/register returned no listener id", "api");
        return result.id;
    }

    async fetchEvents(listenerId: string): Promise<TahomaEvent[]> {
        const events = await this.request<TahomaEvent[] | undefined>(
            "POST", `/events/${encodeURIComponent(listenerId)}/fetch`, undefined, FETCH_TIMEOUT_MS);
        return Array.isArray(events) ? events : [];
    }

    async unregisterEventListener(listenerId: string): Promise<void> {
        await this.request<unknown>("POST", `/events/${encodeURIComponent(listenerId)}/unregister`);
    }

    /** Opens two connections in parallel so that commands find an idle socket. */
    warmUp(): void {
        for (let i = 0; i < 2; i++) {
            this.getApiVersion().catch((error) => this.log.debug(`warm-up request failed: ${error}`));
        }
    }

    close(): void {
        this.agent.destroy();
    }

    private async request<T>(method: Method, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
        try {
            return await this.send<T>(method, path, body, timeoutMs);
        } catch (error) {
            // A keep-alive socket closed by the box: the request did not reach it, send it again.
            if (isStaleSocketError(error)) {
                this.log.debug(`${method} ${path}: stale connection, retrying`);
                return this.send<T>(method, path, body, timeoutMs);
            }
            throw error;
        }
    }

    private send<T>(method: Method, path: string, body: unknown, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
            const headers: http.OutgoingHttpHeaders = {
                Accept: "application/json",
                Authorization: `Bearer ${this.options.token}`,
            };
            if (method !== "GET") {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = payload?.length ?? 0;
            }

            const started = Date.now();
            const req = this.transport.request({
                host: this.options.host,
                port: this.options.port,
                method,
                path: API_BASE_PATH + path,
                headers,
                agent: this.agent,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("error", (error) => reject(new TahomaError(error.message, "network")));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    const status = res.statusCode ?? 0;
                    this.log.debug(`${method} ${path} -> ${status} (${Date.now() - started} ms)`);
                    if (status < 200 || status >= 300) {
                        reject(apiError(status, text));
                        return;
                    }
                    if (text.trim() === "") {
                        resolve(undefined as T);
                        return;
                    }
                    try {
                        resolve(JSON.parse(text) as T);
                    } catch {
                        reject(new TahomaError(`invalid JSON in response to ${method} ${path}`, "api", status));
                    }
                });
            });

            req.setTimeout(timeoutMs, () => {
                req.destroy(new TahomaError(`${method} ${path}: no response within ${timeoutMs} ms`, "timeout"));
            });
            req.on("error", (error: NodeJS.ErrnoException) => {
                if (error instanceof TahomaError) {
                    reject(error);
                    return;
                }
                reject(new TahomaError(`${method} ${path}: ${error.message}`, "network", undefined, undefined, error.code, req.reusedSocket));
            });
            req.end(payload);
        });
    }
}
