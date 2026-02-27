import { signal, z } from "simple-signal";

export const sendReceipt = signal("send-receipt")
  .input(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    console.log(`Sending receipt for order ${input.orderId} (charge: ${input.chargeId})`);
  });
