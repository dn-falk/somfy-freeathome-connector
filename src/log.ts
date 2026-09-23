/**
 * Minimal logger. Output goes to stdout/stderr, which ends up in the journal of the
 * System Access Point (see `npm run journal`).
 */
export class Logger {
    static debugEnabled = false;
    /** Suppresses all output, used by the unit tests. */
    static silent = false;

    constructor(private readonly scope: string) {}

    child(scope: string): Logger {
        return new Logger(`${this.scope}/${scope}`);
    }

    debug(message: string, ...args: unknown[]): void {
        if (Logger.debugEnabled && !Logger.silent)
            console.log(this.format("DEBUG", message), ...args);
    }

    info(message: string, ...args: unknown[]): void {
        if (!Logger.silent)
            console.log(this.format("INFO", message), ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        if (!Logger.silent)
            console.warn(this.format("WARN", message), ...args);
    }

    error(message: string, ...args: unknown[]): void {
        if (!Logger.silent)
            console.error(this.format("ERROR", message), ...args);
    }

    private format(level: string, message: string): string {
        return `${new Date().toISOString()} ${level} [${this.scope}] ${message}`;
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
