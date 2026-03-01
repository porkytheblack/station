import { signal, z } from "station-signal";

export const processOrder = signal("processOrder")
  .input(z.object({ orderId: z.string(), amount: z.number() }))
  .timeout(30_000)
  .step("validate", async (input) => {
    console.log(`[validate] Checking order ${input.orderId}...`);
    if (input.amount <= 0) throw new Error("Invalid amount");
    return { orderId: input.orderId, amount: input.amount, validated: true };
  })
  .step("charge", async (prev) => {
    console.log(`[charge] Charging $${prev.amount} for order ${prev.orderId}...`);
    await new Promise((r) => setTimeout(r, 500));
    const chargeId = `ch_${Math.random().toString(36).slice(2, 10)}`;
    return { orderId: prev.orderId, chargeId };
  })
  .step("fulfill", async (prev) => {
    console.log(`[fulfill] Fulfilling order ${prev.orderId} (charge: ${prev.chargeId})...`);
    await new Promise((r) => setTimeout(r, 300));
    return { orderId: prev.orderId, status: "fulfilled", chargeId: prev.chargeId };
  })
  .build();
