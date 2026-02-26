import { signal, z } from "simple-signal";

export const processOrder = signal("processOrder")
  .input(
    z.object({
      orderId: z.string(),
      amount: z.number(),
    }),
  )
  .timeout(10_000)
  .retries(2)
  .run(async (input) => {
    console.log(`[processOrder] Processing order ${input.orderId} ($${input.amount})...`);

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    console.log(`[processOrder] Order ${input.orderId} completed!`);
  });
