import { broadcast } from "simple-broadcast";
import { validateOrder } from "../signals/validate-order.js";
import { chargePayment } from "../signals/charge-payment.js";
import { sendReceipt } from "../signals/send-receipt.js";
import { notifyWarehouse } from "../signals/notify-warehouse.js";

// Linear chain: validate → charge → [sendReceipt, notifyWarehouse] (fan-out)
export const orderPipeline = broadcast("order-pipeline")
  .input(validateOrder)
  .then(chargePayment, {
    when: (prev) => {
      console.log("Prev value::", prev)
      return (prev["validate-order"] as { valid: boolean }).valid === true
    },
  })
  .then(sendReceipt, notifyWarehouse)
  .build();
