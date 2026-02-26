import { signal, z } from "simple-signal";

export const greet = signal("greet")
  .input(z.object({ name: z.string() }))
  .run(async (input) => {
    console.log(`Hello, ${input.name}!`);
  });
