import { createInterface } from "node:readline/promises";
import { StationClient } from "station-client";
/** Deliberately a read-only control-room view; mutations stay explicit CLI/API operations. */
export async function tui(client: StationClient, context: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("station tui requires an interactive terminal.");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const safe = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  process.stdout.write("\x1b[?1049h");
  try {
    let panel: unknown = await client.connect();
    for (;;) {
      process.stdout.write(`\x1b[2J\x1b[HStation · ${safe(context)} · ${safe(client.url)}\n\n`);
      process.stdout.write(safe(JSON.stringify(panel, null, 2)).slice(0, 18_000) + "\n\n");
      process.stdout.write("1 Health   2 Workers   3 Signals   4 Broadcasts   5 Beacons\n6 Execution owners   7 Runs   q Quit (services keep running)\n");
      let choice: string;
      try { choice = (await reader.question("View › ")).trim(); } catch { break; }
      if (choice === "q") break;
      const paths: Record<string, string> = { "1": "/health", "2": "/stations", "3": "/signals", "4": "/broadcasts", "5": "/beacons", "7": "/runs" };
      try { panel = choice === "6" ? await client.executionStations() : paths[choice] ? await client.request("GET", paths[choice]) : { message: "Choose a numbered view or q." }; }
      catch (error) { panel = { error: error instanceof Error ? error.message : "Request failed." }; }
    }
  } finally { reader.close(); process.stdout.write("\x1b[?1049l"); }
}
