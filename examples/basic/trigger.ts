import { greet } from "./signals/greet.js";

const id = await greet.trigger({ name: "World" });
console.log(`Signal triggered! Entry ID: ${id}`);
