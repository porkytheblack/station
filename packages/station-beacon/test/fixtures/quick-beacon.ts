import { beacon } from "../../src/index.js";

// Returns immediately with a "never" policy — a clean, one-shot completion.
export const quickBeacon = beacon("quick-b")
  .restart("never")
  .run(async () => {
    // completes right away
  });
