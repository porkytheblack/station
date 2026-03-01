import { configure } from "station-signal";
import { sendEmail } from "./signals/send-email.js";

// Trigger remotely via a running Station server
configure({
  endpoint: process.env.STATION_ENDPOINT ?? "http://localhost:4400",
  apiKey: process.env.STATION_API_KEY!,
});

const id = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Hello from station-signal",
  body: "Triggered remotely via the Station API.",
});

console.log(`Run triggered remotely: ${id}`);
process.exit(0);
