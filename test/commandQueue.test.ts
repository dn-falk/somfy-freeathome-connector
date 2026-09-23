import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { Logger } from "../src/log";
import { CommandQueue, CommandSupersededError, EXECUTION_LABEL } from "../src/tahoma/commandQueue";
import { TahomaError } from "../src/tahoma/errors";
import { TahomaAction } from "../src/tahoma/types";
import { delay } from "./support/fakes";

Logger.silent = true;

class RecordingExecutor {
    calls: { actions: TahomaAction[]; label: string }[] = [];
    failWith: ((actions: TahomaAction[]) => Error | undefined) | undefined;

    async execute(actions: TahomaAction[], label: string): Promise<string> {
        this.calls.push({ actions, label });
        const error = this.failWith?.(actions);
        if (error)
            throw error;
        return `exec-${this.calls.length}`;
    }
}

describe("CommandQueue", () => {
    let executor: RecordingExecutor;

    beforeEach(() => {
        executor = new RecordingExecutor();
    });

    it("sends commands of the same event loop turn as one action group", async () => {
        const queue = new CommandQueue(executor, 0);
        const results = await Promise.all([
            queue.send("io://a/1", { name: "close" }),
            queue.send("io://a/2", { name: "close" }),
            queue.send("io://a/3", { name: "setClosure", parameters: [40] }),
        ]);
        assert.deepEqual(results, ["exec-1", "exec-1", "exec-1"]);
        assert.equal(executor.calls.length, 1);
        assert.equal(executor.calls[0].label, EXECUTION_LABEL);
        assert.deepEqual(executor.calls[0].actions, [
            { deviceURL: "io://a/1", commands: [{ name: "close" }] },
            { deviceURL: "io://a/2", commands: [{ name: "close" }] },
            { deviceURL: "io://a/3", commands: [{ name: "setClosure", parameters: [40] }] },
        ]);
    });

    it("keeps only the newest command per device", async () => {
        const queue = new CommandQueue(executor, 0);
        const first = queue.send("io://a/1", { name: "close" });
        const second = queue.send("io://a/1", { name: "stop" });
        await assert.rejects(first, CommandSupersededError);
        assert.equal(await second, "exec-1");
        assert.deepEqual(executor.calls[0].actions, [{ deviceURL: "io://a/1", commands: [{ name: "stop" }] }]);
    });

    it("collects commands within the configured window", async () => {
        const queue = new CommandQueue(executor, 30);
        const first = queue.send("io://a/1", { name: "open" });
        await delay(5);
        const second = queue.send("io://a/2", { name: "open" });
        await Promise.all([first, second]);
        assert.equal(executor.calls.length, 1);
        assert.equal(executor.calls[0].actions.length, 2);

        await queue.send("io://a/1", { name: "close" });
        assert.equal(executor.calls.length, 2);
    });

    it("falls back to single requests if the box rejects the group", async () => {
        executor.failWith = (actions) => actions.some((action) => action.deviceURL === "io://a/gone")
            ? new TahomaError("HTTP 400 NO_SUCH_DEVICE", "api", 400, "NO_SUCH_DEVICE") : undefined;
        const queue = new CommandQueue(executor, 0);
        const ok = queue.send("io://a/1", { name: "open" });
        const gone = queue.send("io://a/gone", { name: "open" });
        assert.equal(await ok, "exec-2");
        await assert.rejects(gone, /NO_SUCH_DEVICE/);
        assert.equal(executor.calls.length, 3);
    });

    it("rejects all commands of a group on network errors", async () => {
        executor.failWith = () => new TahomaError("ECONNREFUSED", "network");
        const queue = new CommandQueue(executor, 0);
        const results = await Promise.allSettled([
            queue.send("io://a/1", { name: "open" }),
            queue.send("io://a/2", { name: "open" }),
        ]);
        assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
        assert.equal(executor.calls.length, 1);
    });

    it("rejects pending and new commands after close", async () => {
        const queue = new CommandQueue(executor, 50);
        const pending = queue.send("io://a/1", { name: "open" });
        queue.close();
        await assert.rejects(pending, /closed/);
        await assert.rejects(queue.send("io://a/1", { name: "open" }), /closed/);
        assert.equal(executor.calls.length, 0);
    });
});
