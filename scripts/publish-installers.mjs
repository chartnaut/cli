#!/usr/bin/env node
/**
 * Publishes install/install.sh and install/install.ps1 to cli/ in the same R2 bucket as the
 * binaries (https://desktop-updates.chartnaut.com/cli/install.sh, …/install.ps1). Short cache so a
 * fix reaches users quickly. install.ps1 is served as text/plain: `irm … | iex` needs text.
 *
 * Needs R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, like publish:r2.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
}
const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
for (const [file, type] of [['install.sh', 'text/x-shellscript; charset=utf-8'], ['install.ps1', 'text/plain; charset=utf-8']]) {
  const body = fs.readFileSync(path.join(root, 'install', file));
  console.log(`[publish] cli/${file} (${body.length} bytes)`);
  await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `cli/${file}`, Body: body, ContentType: type, CacheControl: 'public, max-age=300' }));
}
console.log('[publish] installers done');
