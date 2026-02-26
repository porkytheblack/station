import "./adapter.config.js";
import { processOrder } from "./signals/process-order.js";

const id = await processOrder.trigger({ orderId: "ORD-001", amount: 49.99 });
console.log(`Order signal triggered! Entry ID: ${id}`);
console.log("Entry is now persisted in jobs.db — the runner will pick it up.");
