import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'src/db/migrations');
const destination = path.join(root, 'dist/db/migrations');

// Clear the destination first so a deleted or renamed migration cannot linger in dist/ and be applied.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
