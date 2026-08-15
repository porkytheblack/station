import { broadcast } from "station-broadcast";
import { syncCatalog } from "../signals/sync-catalog.js";
import { renderPreview } from "../signals/render-preview.js";

export const releasePipeline = broadcast("release-pipeline")
  .input(syncCatalog)
  .then(renderPreview)
  .onFailure("fail-fast")
  .timeout(60_000)
  .build();
