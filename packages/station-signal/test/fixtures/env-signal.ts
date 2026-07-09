import { signal, z } from "../../src/index.js";

/**
 * Fixture: requires TEST_ENV_VAR and echoes it back as output, so a test can
 * assert both that the requirement is enforced and that an injected value
 * reaches the handler via process.env.
 */
export const envSignal = signal("env-signal")
  .input(z.object({}))
  .output(z.object({ seen: z.string() }))
  .env("TEST_ENV_VAR")
  .run(async () => {
    return { seen: process.env.TEST_ENV_VAR ?? "<undefined>" };
  });
