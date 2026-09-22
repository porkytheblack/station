import { signal, z } from "station-signal";

const input = z.object({ id: z.number(), delayMs: z.number().int().min(0).max(2_000) });

export const networkWork = signal("network-work")
  .input(input)
  .concurrency({ station: 2, network: 3 })
  .run(async ({ id, delayMs }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { id, pid: process.pid };
  });

export const gpuWork = signal("gpu-work")
  .input(input)
  .concurrency({ station: 1, network: 1 })
  .placement({ labels: { gpu: "true" } })
  .run(async ({ id, delayMs }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { id, pid: process.pid };
  });
