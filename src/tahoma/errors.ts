export type TahomaErrorKind =
    /** Connection problems (refused, reset, DNS, TLS). */
    | "network"
    /** No response within the request timeout. */
    | "timeout"
    /** Token missing, wrong or revoked (HTTP 401). */
    | "auth"
    /** The event listener expired or the box rebooted; a new listener must be registered. */
    | "invalidListener"
    /** Any other error reported by the API. */
    | "api";

export class TahomaError extends Error {
    constructor(
        message: string,
        readonly kind: TahomaErrorKind,
        readonly status?: number,
        readonly errorCode?: string,
        readonly code?: string,
        /** The request was sent on a keep-alive socket that had been used before. */
        readonly reusedSocket = false,
    ) {
        super(message);
        this.name = "TahomaError";
    }
}

interface ApiErrorBody {
    error?: unknown;
    errorCode?: unknown;
}

/** Maps an error response of the local API to a {@link TahomaError}. */
export function apiError(status: number, body: string): TahomaError {
    let parsed: ApiErrorBody = {};
    try {
        parsed = JSON.parse(body) as ApiErrorBody;
    } catch {
        // not JSON, keep the raw text
    }
    const errorCode = typeof parsed.errorCode === "string" ? parsed.errorCode : undefined;
    const text = typeof parsed.error === "string" ? parsed.error.replace(/^"|"$/g, "") : body.trim();
    const message = `HTTP ${status}${errorCode ? ` ${errorCode}` : ""}${text ? `: ${text}` : ""}`;

    if (status === 401)
        return new TahomaError(message, "auth", status, errorCode);
    if (errorCode === "UNSPECIFIED_ERROR" && /listener/i.test(text))
        return new TahomaError(message, "invalidListener", status, errorCode);
    return new TahomaError(message, "api", status, errorCode);
}

/**
 * Errors that typically happen when a keep-alive socket was closed by the box while the
 * request was sent. Such requests never reached the box and can be repeated safely.
 */
export function isStaleSocketError(error: unknown): boolean {
    if (!(error instanceof TahomaError) || error.kind !== "network" || !error.reusedSocket)
        return false;
    return error.code === "ECONNRESET" || error.code === "EPIPE" || /socket hang up/i.test(error.message);
}
