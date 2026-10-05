import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { notFound } from '../utils/errors.js';

const root = path.resolve(env.STORAGE_DIR);
const KEY_RE = /^(proofs|reports)\/[0-9a-f-]{36}\.(jpg|png|pdf)$/;

/** Local-disk driver. Swap this module's functions for an S3/GCS client to use object storage; callers only see keys. */
export async function save(buffer, kind, ext) {
  const key = `${kind}/${crypto.randomUUID()}.${ext}`;
  const full = resolveKey(key);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, buffer, { mode: 0o640 });
  return key;
}

export function resolveKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw notFound('File');
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw notFound('File');
  return full;
}

export async function read(key) {
  try {
    return await fsp.readFile(resolveKey(key));
  } catch (error) {
    if (error.code === 'ENOENT') throw notFound('File');
    throw error;
  }
}

export async function stat(key) {
  try {
    return await fsp.stat(resolveKey(key));
  } catch (error) {
    if (error.code === 'ENOENT') throw notFound('File');
    throw error;
  }
}

export const createReadStream = (key) => fs.createReadStream(resolveKey(key));

export async function remove(key) {
  if (!key) return;
  try {
    await fsp.unlink(resolveKey(key));
  } catch {
    /* already gone */
  }
}

export const contentTypeFor = (key) => ({ jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' })[key.split('.').pop()] || 'application/octet-stream';
