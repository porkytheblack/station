import { broadcast } from "station-broadcast";
import { checkRepo } from "../signals/check-repo.js";
import { runBuild } from "../signals/run-build.js";
import { runTests } from "../signals/run-tests.js";
import { deployStaging } from "../signals/deploy-staging.js";
import { sendBuildNotification } from "../signals/send-notification.js";

export const buildPipeline = broadcast("build-pipeline")
  .input(checkRepo)
  .then(runBuild)
  .then(runTests)
  .then(deployStaging)
  .then(sendBuildNotification)
  .timeout(120_000)
  .build();
