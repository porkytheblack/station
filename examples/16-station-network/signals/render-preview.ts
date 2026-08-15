import { signal, z } from "station-signal";

export const renderPreview = signal("render-preview")
  .input(z.object({ source: z.string(), release: z.string(), records: z.number().optional() }))
  .output(z.object({ url: z.string(), release: z.string() }))
  .env("ASSET_BUCKET")
  .concurrency({ station: 1, network: 1 })
  .placement({ labels: { gpu: "true", region: "ke" } })
  .run(async ({ release }) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const bucket = process.env.ASSET_BUCKET!;
    return { url: `https://${bucket}/${release}/preview.webp`, release };
  });
