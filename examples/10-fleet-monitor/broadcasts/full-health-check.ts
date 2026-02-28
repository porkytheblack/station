import { broadcast } from "simple-broadcast";
import { initHealthCheck } from "../signals/init-health-check.js";
import { checkApi } from "../signals/check-api.js";
import { checkDatabase } from "../signals/check-database.js";
import { checkRedis } from "../signals/check-redis.js";
import { checkQueue } from "../signals/check-queue.js";
import { checkDisk } from "../signals/check-disk.js";
import { checkMemory } from "../signals/check-memory.js";
import { aggregateReport } from "../signals/aggregate-report.js";

// DAG:
//   init-health-check
//     ├─→ check-api
//     ├─→ check-database
//     ├─→ check-redis
//     ├─→ check-queue
//     ├─→ check-disk
//     └─→ check-memory
//           ↓
//     aggregate-report

export const fullHealthCheck = broadcast("full-health-check")
  .input(initHealthCheck)
  .then(checkApi, checkDatabase, checkRedis, checkQueue, checkDisk, checkMemory)
  .then(aggregateReport)
  .onFailure("continue") // keep checking remaining services even if one fails
  .timeout(30_000)
  .build();
