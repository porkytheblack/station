import { signal, z } from "simple-signal";

export const sendEmail = signal("sendEmail")
  .input(z.object({ to: z.string(), subject: z.string(), body: z.string() }))
  .timeout(10_000)
  .step("validate", async (input) => {
    console.log(`[validate] Checking email to ${input.to}...`);
    if (!input.to.includes("@")) throw new Error("Invalid email address");
    return input;
  })
  .step("send", async (email) => {
    console.log(`[send] Sending "${email.subject}" to ${email.to}...`);
    await new Promise((r) => setTimeout(r, 500));
    const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
    console.log(`[send] Sent! Message ID: ${messageId}`);
    return { messageId };
  })
  .build();
