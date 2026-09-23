import { Logger, errorMessage } from "../log";
import { TahomaError } from "./errors";
import { TahomaAction, TahomaCommand } from "./types";

export interface CommandExecutor {
    execute(actions: TahomaAction[], label: string): Promise<string>;
}

/** A command was replaced by a newer command for the same device before it was sent. */
export class CommandSupersededError extends Error {
    constructor(deviceURL: string) {
        super(`command for ${deviceURL} was replaced by a newer command`);
        this.name = "CommandSupersededError";
    }
}

interface PendingCommand {
    command: TahomaCommand;
    resolve: (execId: string) => void;
    reject: (error: unknown) => void;
}

export const EXECUTION_LABEL = "free@home";

/**
 * Collects commands and sends them to the box with as little delay as possible.
 *
 * - Commands that arrive within `windowMs` (or in the same event loop turn if `windowMs` is 0)
 *   are sent as one action group. A free@home push button that is linked to several roller
 *   shutters thereby results in a single request.
 * - The box accepts only one action per device and action group, and for a roller shutter only
 *   the latest wish counts: a newer command for the same device replaces a pending one.
 */
export class CommandQueue {
    private pending = new Map<string, PendingCommand>();
    private timer: NodeJS.Timeout | undefined;
    private immediate: NodeJS.Immediate | undefined;
    private closed = false;

    constructor(
        private readonly executor: CommandExecutor,
        private readonly windowMs: number,
        private readonly log = new Logger("queue"),
    ) {}

    send(deviceURL: string, command: TahomaCommand): Promise<string> {
        if (this.closed)
            return Promise.reject(new Error("command queue is closed"));
        return new Promise<string>((resolve, reject) => {
            const previous = this.pending.get(deviceURL);
            if (previous) {
                this.pending.delete(deviceURL);
                previous.reject(new CommandSupersededError(deviceURL));
            }
            this.pending.set(deviceURL, { command, resolve, reject });
            this.schedule();
        });
    }

    /** Rejects all pending commands and refuses new ones. */
    close(): void {
        this.closed = true;
        this.cancelTimer();
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending)
            entry.reject(new Error("command queue is closed"));
    }

    private schedule(): void {
        if (this.timer || this.immediate)
            return;
        if (this.windowMs > 0)
            this.timer = setTimeout(() => void this.flush(), this.windowMs);
        else
            this.immediate = setImmediate(() => void this.flush());
    }

    private cancelTimer(): void {
        if (this.timer)
            clearTimeout(this.timer);
        if (this.immediate)
            clearImmediate(this.immediate);
        this.timer = undefined;
        this.immediate = undefined;
    }

    private async flush(): Promise<void> {
        this.timer = undefined;
        this.immediate = undefined;
        const batch = [...this.pending.entries()];
        this.pending.clear();
        if (batch.length === 0)
            return;

        const actions: TahomaAction[] = batch.map(([deviceURL, entry]) => ({ deviceURL, commands: [entry.command] }));
        this.log.debug(`sending ${actions.map((a) => `${a.commands[0].name}${formatParameters(a.commands[0])} -> ${a.deviceURL}`).join(", ")}`);
        try {
            const execId = await this.executor.execute(actions, EXECUTION_LABEL);
            for (const [, entry] of batch)
                entry.resolve(execId);
        } catch (error) {
            // The box rejects the whole group if one action is invalid (e.g. a removed device).
            // Send the commands one by one so the others still work.
            if (batch.length > 1 && error instanceof TahomaError && error.kind === "api") {
                this.log.warn(`group command failed (${errorMessage(error)}), sending commands individually`);
                await Promise.all(batch.map(async ([deviceURL, entry]) => {
                    try {
                        entry.resolve(await this.executor.execute([{ deviceURL, commands: [entry.command] }], EXECUTION_LABEL));
                    } catch (singleError) {
                        entry.reject(singleError);
                    }
                }));
                return;
            }
            for (const [, entry] of batch)
                entry.reject(error);
        }
    }
}

function formatParameters(command: TahomaCommand): string {
    return command.parameters && command.parameters.length > 0 ? `(${command.parameters.join(", ")})` : "";
}
