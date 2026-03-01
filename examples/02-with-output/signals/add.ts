import { signal, z } from "station-signal";

export const add = signal("add")
  .input(z.object({ a: z.number(), b: z.number() }))
  .output(z.number())
  .run(async (input) => {
    const sum = input.a + input.b;
    console.log(`${input.a} + ${input.b} = ${sum}`);
    return sum;
  })
  .onComplete(async (output, input) => {
    console.log(`[onComplete] add(${input.a}, ${input.b}) returned ${output}`);
  });
