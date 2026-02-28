import { signal, z } from "simple-signal";

export const greet = signal("greet")
  .input(z.object({ name: z.string() }))
  .every("5s")
  .run(async (input) => {
    console.log(`Hello, ${input.name}!`);
  });
