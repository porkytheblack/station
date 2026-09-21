// Documentation completeness check only: this does not execute backend methods.
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const documentation = read('docs/STATION-CLI-COVERAGE.md');
const methods = [...new Set([...read('packages/station-daemon/src/server/routes/execution.ts').matchAll(/case "([A-Za-z]+)":/g)].map(match => match[1]))];
const union = read('packages/station-browser-use/src/commands.ts').split('export type BrowserCommand =')[1]?.split('export interface BrowserAuditEntry')[0];
if (!union || methods.length === 0) throw new Error('Execution contract format changed; update this documentation check.');
const operations = [...new Set([...union.matchAll(/op: ([^;}]+)/g)].flatMap(match => [...match[1].matchAll(/"([A-Za-z]+)"/g)].map(op => op[1])))];
const missing = [...new Set([...methods, ...operations])].filter(name => !documentation.includes(`\`${name}\``));
if (missing.length) throw new Error(`CLI coverage map omits current operations: ${missing.join(', ')}`);
console.log(`CLI coverage map names all ${methods.length} distinct execution RPCs and ${operations.length} browser commands. Backend behavior requires its separate tests.`);
