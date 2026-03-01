import { signal, z } from "station-signal";

export const validateOrder = signal("validate-order")
  .input(z.object({ orderId: z.string(), amount: z.number() }))
  .output(z.object({ orderId: z.string(), amount: z.number(), valid: z.boolean() }))
  .run(async (input) => {
    console.log(`Validating order ${input.orderId} ($${input.amount})`);
    return { orderId: input.orderId, amount: input.amount, valid: input.amount > 0 };
  });
