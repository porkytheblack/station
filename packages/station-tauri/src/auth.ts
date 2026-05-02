import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { KeyStore } from "station-kit/server";

/**
 * Get or create an API key for the Tauri desktop app.
 *
 * On first launch, creates an API key with all scopes and saves the raw key
 * to `{dataDir}/.station-key`. On subsequent launches, reads the saved key
 * and verifies it's still valid — if revoked or missing, creates a new one.
 */
export async function getOrCreateApiKey(keyStore: KeyStore, dataDir: string): Promise<string> {
  const keyFilePath = resolve(dataDir, ".station-key");

  // Try reading an existing key
  if (existsSync(keyFilePath)) {
    const savedKey = readFileSync(keyFilePath, "utf-8").trim();
    if (savedKey) {
      const record = await keyStore.verify(savedKey);
      if (record) {
        return savedKey;
      }
    }
  }

  // Create a new key with all scopes
  const { key } = await keyStore.create("tauri-desktop", ["trigger", "read", "cancel", "admin"]);

  // Persist to disk
  const dir = dirname(keyFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(keyFilePath, key, { mode: 0o600 });

  return key;
}
