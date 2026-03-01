import { broadcast } from "station-broadcast";
import { extractUsers } from "../signals/extract-users.js";
import { transformUsers } from "../signals/transform-users.js";
import { loadUsers } from "../signals/load-users.js";
import { generateReport } from "../signals/generate-report.js";

// Linear DAG: extract → transform → load → report
export const etlPipeline = broadcast("etl-pipeline")
  .input(extractUsers)
  .then(transformUsers)
  .then(loadUsers)
  .then(generateReport)
  .timeout(60_000)
  .build();
