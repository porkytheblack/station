// Repository smoke: uses station-sandbox's optional development PTY dependency, not a CLI runtime dependency.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(new URL("../../station-sandbox/package.json", import.meta.url));
const pty = require("node-pty");
const home = await mkdtemp(join(tmpdir(), "station-tui-pty-")), journal = join(home, "requests.jsonl");
const tuiURL = new URL("../dist/tui.js", import.meta.url).href;
const clientURL = new URL("../../station-client/dist/index.js", import.meta.url).href;
const source = `
import { appendFileSync } from 'node:fs';
import { tui } from ${JSON.stringify(tuiURL)};
import { StationClient } from ${JSON.stringify(clientURL)};
let streams = 0;
const client = new StationClient({url:'https://hq.example'}, {fetch: async (url, options) => {
 const path = new URL(url).pathname;
 appendFileSync(${JSON.stringify(journal)}, JSON.stringify({path,method:options?.method ?? 'GET',cursor:new Headers(options?.headers).get('last-event-id')})+'\\n');
 if(path.endsWith('/events')) {
   const number=++streams;
   return new Response(new ReadableStream({start(controller) {
     controller.enqueue(new TextEncoder().encode('id: epoch:'+number+'\\nevent: stream.ready\\ndata: {}\\n\\n'));
     if(number===1) controller.close();
     else options.signal.addEventListener('abort',()=>controller.close(),{once:true});
   }}));
 }
 const data = path.endsWith('/info') ? {protocol:'station.api/v1',version:'3.0.0',stationId:'hq',role:'headquarters',capabilities:[]}
 : path.endsWith('/signals') ? [{name:'pty-signal'}]
 : path.endsWith('/trigger') ? {accepted:true} : {name:'pty-signal'};
 return new Response(JSON.stringify({data}));
}});
await tui(client,'PTY smoke');
`;
let terminal, output = "", exited;
async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline || exited) throw new Error(`PTY smoke did not reach ${label}: ${output.slice(-1500)}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function enter(text, expected) {
  output = ""; terminal.write(`${text}\r`); await until(() => output.includes(expected), expected);
}
try {
  terminal = pty.spawn(process.execPath, ["--input-type=module", "-e", source], { name: "xterm-256color", cols: 90, rows: 30, cwd: home, env: { ...process.env } });
  terminal.onData(data => { output += data; });
  const done = new Promise(resolve => terminal.onExit(event => { exited = event; resolve(event); }));
  await until(() => output.includes("Home · live"), "live home");
  await until(() => output.includes("reconnecting"), "reconnecting status");
  await new Promise(resolve => setTimeout(resolve, 350));
  await enter("3", "signals · live");
  terminal.resize(115, 35);
  await enter("1", "a1 Run signal");
  await enter("a1", "JSON input file");
  await enter("", "Type yes:");
  assert.ok(output.includes("https://hq.example · pty-signal"));
  await enter("yes", '"accepted": true');
  terminal.write("q\r");
  const result = await Promise.race([done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("TUI did not exit cleanly")), 5000); timer.unref(); })]);
  assert.equal(result.exitCode, 0); assert.ok(output.includes("\x1b[?1049l"));
  const requests = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter(request => request.path.endsWith("/trigger")).length, 1);
  const events = requests.filter(request => request.path.endsWith("/events"));
  assert.equal(events.length, 2); assert.equal(events[1].cursor, "epoch:1");
  console.log("Real PTY smoke passed: live reconnect/cursor, navigation, resize, confirmed single mutation, clean exit.");
} finally { if (terminal && !exited) terminal.kill(); await rm(home, {recursive:true,force:true}); }
