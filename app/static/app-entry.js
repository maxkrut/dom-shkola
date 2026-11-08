import * as maplibregl from "./vendor/maplibre/maplibre-gl.mjs";
import { viewerApi } from "./viewer-api.mjs?v=20261108-state-fixes";
import * as schoolAreaTiles from "./school-area-tiles.mjs?v=20261108-state-fixes";
import { installDeliveryInfo } from "./delivery-info.mjs?v=20261030-freshness-inline-1";
import { installCompactShell } from "./compact-shell.mjs?v=20261108-current-fragments-legend";
import { suppressGardenHouseDuplicates, sourceOnlyGardenFeatures } from "./register-search-core.mjs?v=20261108-garden-search-2";


window.maplibregl = maplibregl;
window.schoolViewerApi = viewerApi;
window.schoolAreaTileModule = schoolAreaTiles;
window.suppressGardenHouseDuplicates = suppressGardenHouseDuplicates;
window.sourceOnlyGardenFeatures = sourceOnlyGardenFeatures;
void installDeliveryInfo(viewerApi);
await import("./source-evidence.mjs?v=20261108-state-fixes");
await import("./app.js?v=20261108-garden-search-2");
installCompactShell();
