import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.BIOMEMAP_DATA_DIR ? path.resolve(process.env.BIOMEMAP_DATA_DIR) : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const PLANTS_FILE = path.join(DATA_DIR, 'plants.json');
export const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
export const DIST_DIR = path.join(ROOT, 'dist');
