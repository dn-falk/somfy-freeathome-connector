import { fstatSync } from "node:fs";
import { inspect } from "node:util";

/** Syslog priorities understood by the systemd journal as line prefix ("<4>message"). */
const PRIORITY_WARNING = 4;
const PRIORITY_ERROR = 3;

/**
 * True if the file descriptor is the stream to the systemd journal that `JOURNAL_STREAM`
 * ("<device>:<inode>", set by systemd for services) describes.
 */
export function isJournalStream(journalStream: string | undefined, fd: number): boolean {
    const match = /^(\d+):(\d+)$/.exec(journalStream ?? "");
    if (!match)
        return false;
    try {
        const stat = fstatSync(fd, { bigint: true });
        return stat.dev === BigInt(match[1]) && stat.ino === BigInt(match[2]);
    } catch {
        return false;
    }
}

/**
 * Minimal logger. Output goes to stdout/stderr, which ends up in the journal of the
 * System Access Point (see `npm run journal`).
 */
export class Logger {
    static debugEnabled = false;
    /** Suppresses all output, used by the unit tests. */
    static silent = false;
    /**
     * Marks warnings and errors with their priority for the journal. Only done if stderr is
     * connected to the journal directly; elsewhere (development on a PC) the prefix would show.
     * Info and debug messages keep the default priority "info", so they are stored even if the
     * journal drops debug messages.
     */
    static journalPriorities = isJournalStream(process.env.JOURNAL_STREAM, 2);

    constructor(private readonly scope: string) {}

    child(scope: string): Logger {
        return new Logger(`${this.scope}/${scope}`);
    }

    debug(message: string, ...args: unknown[]): void {
        if (Logger.debugEnabled && !Logger.silent)
            console.log(this.format("DEBUG", message, args));
    }

    info(message: string, ...args: unknown[]): void {
        if (!Logger.silent)
            console.log(this.format("INFO", message, args));
    }

    warn(message: string, ...args: unknown[]): void {
        if (!Logger.silent)
            console.warn(this.format("WARN", message, args, PRIORITY_WARNING));
    }

    error(message: string, ...args: unknown[]): void {
        if (!Logger.silent)
            console.error(this.format("ERROR", message, args, PRIORITY_ERROR));
    }

    private format(level: string, message: string, args: unknown[], priority?: number): string {
        const prefix = priority !== undefined && Logger.journalPriorities ? `<${priority}>` : "";
        const details = args.map((arg) => ` ${typeof arg === "string" ? arg : inspect(arg)}`).join("");
        return `${prefix}${new Date().toISOString()} ${level} [${this.scope}] ${logSafe(message + details)}`;
    }
}

/**
 * Replaces double quotes and backslashes (also in error messages of the box or the library). The
 * log view in the addon settings of the System Access Point stays empty for this addon although
 * the downloaded log is complete; characters that need escaping in JSON are a suspected cause.
 */
export function logSafe(text: string): string {
    return text.replace(/"/g, "'").replace(/\\/g, "/");
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
