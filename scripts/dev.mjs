// npm run dev / npm run dev:phone
// Runs the API server and the Vite dev server in this one process, so stopping it stops both.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const phone = process.argv.includes('--phone');

const { ready } = await import('../server/index.js');
await ready;
const vite = await createServer({ root, mode: phone ? 'phone' : 'development' });
await vite.listen();
vite.printUrls();
vite.bindCLIShortcuts({ print: true });
