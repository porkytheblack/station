# station-tauri

Embed Station as a localhost-only sidecar in a Tauri desktop application.

```bash
pnpm add station-tauri station-kit station-signal station-adapter-sqlite
```

```ts
import { createTauriStation } from "station-tauri";

const station = await createTauriStation({
  dataDir: appDataDir,
  signalsDir: signalsPath,
});

await station.start();
// Send `Authorization: Bearer ${station.apiKey}` from the Tauri frontend.
```

`createTauriStation()` binds to `127.0.0.1`, disables the browser dashboard,
stores state in the supplied application-data directory, and provisions a
scoped API key for the desktop frontend. Stop it during application shutdown to
let active Station runners close cleanly.

## License

MIT
