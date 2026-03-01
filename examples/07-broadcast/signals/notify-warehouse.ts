import { signal, z } from "station-signal";

export const notifyWarehouse = signal("notify-warehouse")
  .input(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    console.log(`Notifying warehouse for order ${input.orderId}`);
  });
