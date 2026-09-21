import { cp, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const destination = new URL('.next/standalone/packages/station-dashboard/.next/static/', root);
await mkdir(destination, { recursive: true });
await cp(new URL('.next/static/', root), destination, { recursive: true });
