import { flakyTask } from "./signals/flaky-task.js";

const id = await flakyTask.trigger({ message: "important work" });
console.log(`Signal triggered! Entry ID: ${id}`);
console.log("The task has a 50% chance of failing each attempt, with up to 3 retries.");
