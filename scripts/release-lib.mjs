/**
 * Release channels for the standalone CLI, shared by build-binaries, publish-r2 and promote-r2.
 *
 *   stable     cli/<version>/…           cli/latest.json            what installs and upgrades get
 *   unstable   cli/unstable/<version>/…  cli/unstable/latest.json   a candidate, for the release gate
 *
 * Everything that touches the bucket goes through a small store ({ get, put }), so the publish and
 * promote steps run the same way against R2 and against the in-memory store the tests use.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CHANNELS = ['stable', 'unstable'];
export const DEFAULT_RELEASE_BASE = 'https://desktop-updates.chartnaut.com/cli';
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache, max-age=0';

/** The channel from `--channel <name>` / `--channel=<name>`, else CHARTNAUT_CHANNEL, else stable. */
export function channelFrom(argv = [], env = {}) {
  let channel;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') channel = argv[++i];
    else if (a.startsWith('--channel=')) channel = a.slice('--channel='.length);
  }
  channel = (channel ?? env.CHARTNAUT_CHANNEL ?? 'stable').trim();
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel "${channel}": use ${CHANNELS.join(' or ')}`);
  return channel;
}

/** The bucket key prefix of a channel: `cli/` or `cli/unstable/`. */
export function channelPrefix(channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel "${channel}"`);
  return channel === 'stable' ? 'cli/' : `cli/${channel}/`;
}

/** Where a channel's files are served: CHARTNAUT_RELEASE_BASE (the stable root) plus the channel. */
export function releaseBase(channel, env = {}) {
  const root = (env.CHARTNAUT_RELEASE_BASE ?? DEFAULT_RELEASE_BASE).replace(/\/+$/, '');
  return channel === 'stable' ? root : `${root}/${channel}`;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The manifest text. One asset per line on purpose: install.sh reads it with grep/sed, no jq needed. */
export function renderManifest({ version, bun, channel, assets }) {
  const lines = Object.entries(assets).map(([k, v]) => `    "${k}": ${JSON.stringify({ url: v.url, sha256: v.sha256, size: v.size })}`);
  return `{\n  "version": "${version}",\n  "channel": "${channel}",\n  "bun": "${bun}",\n  "assets": {\n${lines.join(',\n')}\n  }\n}\n`;
}

const fileOf = (url) => path.posix.basename(new URL(url).pathname);

/**
 * Refuses a manifest that does not belong to `channel`: every asset URL must sit under
 * /<prefix><version>/ (unless `paths` is false: a build for a custom CHARTNAUT_RELEASE_BASE), and
 * when `dir` is given every file beside it must match its sha256.
 */
export function checkManifest(manifest, channel, dir, { paths = true } = {}) {
  const want = manifest.channel ?? 'stable';
  if (want !== channel) throw new Error(`the manifest was built for the ${want} channel, not ${channel}`);
  const under = `/${channelPrefix(channel)}${manifest.version}/`;
  const entries = Object.entries(manifest.assets ?? {});
  if (!entries.length) throw new Error('the manifest lists no assets');
  for (const [platform, asset] of entries) {
    if (paths && !new URL(asset.url).pathname.includes(under)) throw new Error(`${platform}: ${asset.url} is not under ${under}`);
    if (dir) {
      const file = fileOf(asset.url);
      if (sha256(fs.readFileSync(path.join(dir, file))) !== asset.sha256) throw new Error(`${platform}: ${file} does not match the manifest`);
    }
  }
}

/**
 * Uploads release/ to its channel: binaries and the pinned manifest first, latest.json LAST, so a
 * reader never sees a manifest naming a file that is not there yet.
 */
export async function publishRelease(store, dir, channel, log = () => {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  checkManifest(manifest, channel, dir);
  const prefix = channelPrefix(channel);
  for (const asset of Object.values(manifest.assets)) {
    const file = fileOf(asset.url);
    await store.put(`${prefix}${manifest.version}/${file}`, fs.readFileSync(path.join(dir, file)), 'application/octet-stream', IMMUTABLE);
    log(`${prefix}${manifest.version}/${file}`);
  }
  await store.put(`${prefix}${manifest.version}/manifest.json`, fs.readFileSync(path.join(dir, 'manifest.json')), 'application/json', IMMUTABLE);
  log(`${prefix}${manifest.version}/manifest.json`);
  await store.put(`${prefix}latest.json`, fs.readFileSync(path.join(dir, 'latest.json')), 'application/json', NO_CACHE);
  log(`${prefix}latest.json`);
  return manifest;
}

/**
 * Copies a tested unstable release to stable. Reads the PINNED unstable manifest
 * (cli/unstable/<version>/manifest.json, not unstable/latest.json, which may have moved on),
 * re-checks every binary's sha256 and size against it, copies the binaries to cli/<version>/,
 * writes a stable manifest (URLs under the stable base) to cli/<version>/manifest.json, and
 * cli/latest.json last. A stable binary already at the target key must be byte-identical.
 */
export async function promoteRelease(store, version, { stableBase = DEFAULT_RELEASE_BASE, log = () => {} } = {}) {
  const from = channelPrefix('unstable');
  const to = channelPrefix('stable');
  const raw = await store.get(`${from}${version}/manifest.json`);
  if (!raw) throw new Error(`no unstable release ${version}: ${from}${version}/manifest.json is missing`);
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.version !== version) throw new Error(`${from}${version}/manifest.json says version ${manifest.version}`);
  checkManifest(manifest, 'unstable');

  const assets = {};
  const copies = [];
  for (const [platform, asset] of Object.entries(manifest.assets)) {
    const file = fileOf(asset.url);
    const body = await store.get(`${from}${version}/${file}`);
    if (!body) throw new Error(`${platform}: ${from}${version}/${file} is missing`);
    if (sha256(body) !== asset.sha256) throw new Error(`${platform}: ${from}${version}/${file} does not match its sha256 in the unstable manifest; nothing was promoted`);
    if (asset.size !== undefined && body.length !== asset.size) throw new Error(`${platform}: ${file} is ${body.length} bytes, the manifest says ${asset.size}`);
    const existing = await store.get(`${to}${version}/${file}`);
    if (existing && sha256(existing) !== asset.sha256) throw new Error(`${platform}: ${to}${version}/${file} already exists with different content; refusing to overwrite an immutable release`);
    assets[platform] = { url: `${stableBase.replace(/\/+$/, '')}/${version}/${file}`, sha256: asset.sha256, size: body.length };
    copies.push([`${to}${version}/${file}`, body]);
  }
  // Every check passed before the first write.
  for (const [key, body] of copies) {
    await store.put(key, body, 'application/octet-stream', IMMUTABLE);
    log(key);
  }
  const stable = renderManifest({ version, bun: manifest.bun, channel: 'stable', assets });
  checkManifest(JSON.parse(stable), 'stable');
  await store.put(`${to}${version}/manifest.json`, Buffer.from(stable), 'application/json', IMMUTABLE);
  log(`${to}${version}/manifest.json`);
  await store.put(`${to}latest.json`, Buffer.from(stable), 'application/json', NO_CACHE);
  log(`${to}latest.json`);
  return JSON.parse(stable);
}

/** The R2 bucket as a store. Needs R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. */
export async function r2Store(env = process.env) {
  for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const { GetObjectCommand, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return {
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return undefined;
        throw e;
      }
    },
    async put(key, body, contentType, cacheControl) {
      await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
    },
  };
}
