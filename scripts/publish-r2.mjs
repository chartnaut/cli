#!/usr/bin/env node
/**
 * Publishes release/ (from `npm run build:binaries`) to the R2 bucket behind
 * https://desktop-updates.chartnaut.com, next to the desktop app's channel:
 *
 *   cli/<version>/chartnaut-<platform>[.exe]   immutable
 *   cli/<version>/manifest.json                immutable (pinned installs)
 *   cli/latest.json                            no-cache, uploaded LAST: the switch
 *
 * Binaries go first, latest.json last, so a reader never sees a manifest naming a file that
 * isn't there yet. Needs R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
 * in the environment.
 *
 *   npm run build:binaries && npm run publish:r2
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const PREFIX = 'cli/';

for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
}
const latest = JSON.parse(fs.readFileSync(path.join(release, 'latest.json'), 'utf8'));
const version = latest.version;

// Refuse to publish a manifest that does not match the files beside it.
for (const [platform, asset] of Object.entries(latest.assets)) {
  const file = path.basename(new URL(asset.url).pathname);
  const buf = fs.readFileSync(path.join(release, file));
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== asset.sha256) throw new Error(`${platform}: ${file} does not match latest.json`);
  if (!asset.url.includes(`/cli/${version}/`)) throw new Error(`${platform}: ${asset.url} is not under /cli/${version}/`);
}

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const put = async (key, file, contentType, cacheControl) => {
  const body = fs.readFileSync(path.join(release, file));
  console.log(`[publish] ${key} (${(body.length / 1e6).toFixed(1)} MB)`);
  await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
for (const asset of Object.values(latest.assets)) {
  const file = path.basename(new URL(asset.url).pathname);
  await put(`${PREFIX}${version}/${file}`, file, 'application/octet-stream', IMMUTABLE);
}
await put(`${PREFIX}${version}/manifest.json`, 'manifest.json', 'application/json', IMMUTABLE);
await put(`${PREFIX}latest.json`, 'latest.json', 'application/json', 'no-cache, max-age=0');
console.log(`[publish] done: chartnaut ${version} is live`);
