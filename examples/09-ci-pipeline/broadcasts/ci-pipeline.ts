import { broadcast } from "station-broadcast";
import { checkout } from "../signals/checkout.js";
import { lint } from "../signals/lint.js";
import { testUnit } from "../signals/test-unit.js";
import { testIntegration } from "../signals/test-integration.js";
import { buildApp } from "../signals/build-app.js";
import { deployStaging } from "../signals/deploy-staging.js";
import { deployProd } from "../signals/deploy-prod.js";
import { notify } from "../signals/notify.js";

// DAG:
//   checkout
//     ├─→ lint
//     ├─→ test-unit (flaky, 2 retries)
//     └─→ test-integration (flaky, 1 retry)
//           ↓ (waits for tests + checkout)
//        build-app
//           ↓
//      deploy-staging
//           ↓
//      deploy-prod (guard: only if branch is "main")
//           ↓
//        notify (falls back to staging output if prod skipped)

export const ciPipeline = broadcast("ci-pipeline")
  .input(checkout)
  .then(lint, testUnit, testIntegration) // fan-out: all run in parallel
  .then(buildApp, {
    // Wait for all tests AND checkout; pass checkout output as build input
    after: ["lint", "test-unit", "test-integration", "checkout"],
    map: (upstream) => upstream["checkout"],
  })
  .then(deployStaging)
  .then(deployProd, {
    // Need checkout data for the branch guard
    after: ["deploy-staging", "checkout"],
    map: (upstream) => upstream["deploy-staging"],
    when: (upstream) => {
      const co = upstream["checkout"] as { branch: string } | undefined;
      return co?.branch === "main";
    },
  })
  .then(notify, {
    // If deploy-prod was skipped (non-main branch), fall back to staging output
    after: ["deploy-prod", "deploy-staging"],
    map: (upstream) => upstream["deploy-prod"] ?? upstream["deploy-staging"],
  })
  .onFailure("fail-fast")
  .timeout(120_000)
  .build();
