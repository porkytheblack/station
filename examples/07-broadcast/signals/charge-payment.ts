import { signal, z } from "simple-signal";

export const chargePayment = signal("charge-payment")
  .input(z.object({ orderId: z.string(), amount: z.number(), valid: z.boolean() }))
  .output(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    const chargeId = `ch_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`Charging $${input.amount} for order ${input.orderId} → ${chargeId}`);
    return { orderId: input.orderId, chargeId };
  });
