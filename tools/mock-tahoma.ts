/**
 * Simulated TaHoma Switch for development without a box.
 *
 *   npm run mock -- --port 18443 --token dev-token --shutters "Wohnzimmer,Küche,Bad" --travel 20
 *
 * The addon connects to it via plain HTTP when started with TAHOMA_INSECURE_HTTP=1
 * (see README, section "Entwicklung").
 */
import { TahomaSimulator } from "../test/support/tahomaSimulator";

function argument(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
    const port = Number(argument("port", "18443"));
    const token = argument("token", "dev-token");
    const travelMs = Number(argument("travel", "20")) * 1000;
    const labels = argument("shutters", "Wohnzimmer,Küche,Schlafzimmer").split(",").map((label) => label.trim()).filter(Boolean);

    const simulator = new TahomaSimulator({
        token,
        tickMs: 250,
        shutters: labels.map((label, index) => ({ id: String(10_000_001 + index), label, position: 0, travelMs })),
        log: (message) => console.log(`${new Date().toISOString()} ${message}`),
    });
    await simulator.listen(port, "0.0.0.0");
    console.log(`Simulated TaHoma Switch listening on http://0.0.0.0:${port}`);
    console.log(`Token: ${token}`);
    console.log(`Roller shutters: ${labels.join(", ")} (travel time ${travelMs / 1000} s)`);

    const shutdown = () => {
        void simulator.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

void main();
