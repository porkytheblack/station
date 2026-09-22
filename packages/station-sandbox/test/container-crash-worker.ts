import { ContainerSandboxAdapter } from "../src/container.js";
const adapter = new ContainerSandboxAdapter(JSON.parse(process.argv[2]));
await adapter.ready();
const workspace = await adapter.create();
const service = await adapter.startService(workspace.id, { name: "recovered-service", command: "node -e 'setInterval(()=>{},1000)'" });
const run = await adapter.exec(workspace.id, { command: "printf recovery-checkpoint; sleep 120", timeoutMs: 180_000 });
await new Promise((resolve) => setTimeout(resolve, 1500));
process.stdout.write(`${JSON.stringify({ workspace, service, run })}\n`);
