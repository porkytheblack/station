import { beacon } from "../../src/index.js";

// Crashes immediately on every incarnation — exercises restart + backoff.
export const crashBeacon = beacon("crash-b")
  .restart("on-failure")
  .backoff(40, { factor: 1, max: 40, resetAfter: 999_999 })
  .run(async () => {
    throw new Error("boom");
  });
