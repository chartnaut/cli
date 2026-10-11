import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiError, world, type World } from './harness.js';
import { TOKEN } from './fixtures.js';

const ROOT = { ref: 'jane/orb-breakout', kind: 'definition', name: 'ORB breakout', author: 'jane', status: 'installable' };
const NEEDS = [
  { ref: 'jane/session-range', kind: 'indicator', name: 'Session range', author: 'jane', status: 'installable' },
  { ref: 'sam/atr-bands', kind: 'indicator', name: 'ATR bands', author: 'sam', status: 'installable' },
];
const REQUIREMENTS = { root: ROOT, needs: NEEDS, cannot_add: [], truncated: false, confirm: NEEDS.map((n) => n.ref), message: 'To use ORB breakout, we will add 2 more scripts to your library.' };

describe('library add, needs, remove, and runs of scripts not in your library', () => {
  let w: World;
  before(async () => (w = await world(TOKEN)));
  after(() => w.dispose());
  beforeEach(() => w.api.reset());

  /** The server's agreement step: adding refuses until confirm lists every needed script. */
  const addRoute = () =>
    w.api.on('POST /library/jane/orb-breakout', (req) => {
      const missing = REQUIREMENTS.confirm.filter((r) => !(req.body?.confirm ?? []).includes(r));
      if (missing.length) return apiError(409, 'confirmation_required', 'Adding ORB breakout also adds scripts you have not agreed to.');
      return { status: 201, json: { added: true, root: ROOT, added_with: REQUIREMENTS.confirm, skipped: [] } };
    });

  it('needs lists what would be added and changes nothing', async () => {
    w.api.on('GET /library/jane/orb-breakout/requirements', { json: REQUIREMENTS });
    const r = await w.cli(['library', 'needs', 'jane/orb-breakout']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Adding it also adds 2 scripts to your library:/);
    assert.match(r.stdout, /sam\/atr-bands\s+indicator\s+sam\s+installable/);
    assert.deepEqual(w.api.requests.map((q) => q.method), ['GET']);
  });

  it('add without a terminal and without --yes refuses (exit 4) and adds nothing', async () => {
    w.api.on('GET /library/jane/orb-breakout/requirements', { json: REQUIREMENTS });
    addRoute();
    const r = await w.cli(['library', 'add', 'jane/orb-breakout']);
    assert.equal(r.code, 4);
    assert.match(r.stdout, /To use ORB breakout, we'll add 2 more scripts to your library:/);
    assert.match(r.stdout, /They stay yours, and you can remove them whenever you like\./);
    assert.match(r.stderr, /error: confirmation_required: .*--yes/);
    assert.equal(w.api.calls('POST /library/jane/orb-breakout').length, 0);
  });

  it('add --yes sends the agreed list and reports what was added', async () => {
    w.api.on('GET /library/jane/orb-breakout/requirements', { json: REQUIREMENTS });
    addRoute();
    const r = await w.cli(['library', 'add', 'jane/orb-breakout', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    const [post] = w.api.calls('POST /library/jane/orb-breakout');
    assert.deepEqual(post!.body, { confirm: ['jane/session-range', 'sam/atr-bands'] });
    assert.equal(post!.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(r.stdout, /^Added ORB breakout \(jane\/orb-breakout\) to your library\.$/m);
    assert.match(r.stdout, /^Also added: jane\/session-range, sam\/atr-bands$/m);
  });

  it('add --json prints the API answer on stdout', async () => {
    w.api.on('GET /library/jane/orb-breakout/requirements', { json: { ...REQUIREMENTS, root: { ...ROOT, status: 'installed' }, needs: [], confirm: [] } });
    w.api.on('POST /library/jane/orb-breakout', { status: 200, json: { added: false, root: ROOT, reason: 'It is already in your library.' } });
    const r = await w.cli(['library', 'add', 'jane/orb-breakout', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { added: false, root: ROOT, reason: 'It is already in your library.' });
  });

  it('add of a script that uses unshared scripts exits 4 with their names', async () => {
    w.api.on('GET /library/jane/orb-breakout/requirements', { json: { ...REQUIREMENTS, confirm: [], cannot_add: [{ kind: 'indicator', name: 'Private bands' }] } });
    const r = await w.cli(['library', 'add', 'jane/orb-breakout', '--yes']);
    assert.equal(r.code, 4);
    assert.match(r.stdout, /can't be added: it uses 1 script that isn't shared with you/);
    assert.match(r.stdout, /Private bands\s+indicator/);
    assert.equal(w.api.calls('POST /library/jane/orb-breakout').length, 0);
  });

  it('remove deletes it from the library', async () => {
    w.api.on('DELETE /library/jane/orb-breakout', { json: { removed: true, ref: 'jane/orb-breakout', kind: 'definition' } });
    const r = await w.cli(['library', 'remove', 'jane/orb-breakout']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Removed jane\/orb-breakout \(definition\) from your library\./m);
    w.api.on('DELETE /library/jane/orb-breakout', apiError(404, 'not_found', 'jane/orb-breakout is not in your library.'));
    const again = await w.cli(['library', 'remove', 'jane/orb-breakout']);
    assert.equal(again.code, 4);
    assert.match(again.stderr, /not_found: jane\/orb-breakout is not in your library\./);
  });

  it('run of a script not in the library prints the add command and exits 4', async () => {
    // details sit inside error (apiError puts extra fields beside it).
    w.api.on('POST /runs', {
      status: 409,
      json: { error: { code: 'not_in_library', message: 'jane/orb-breakout is not in your library.', details: { ref: 'jane/orb-breakout', add: 'POST /library/jane/orb-breakout', needs: NEEDS, cannot_add: [], confirm: REQUIREMENTS.confirm } } },
    });
    const r = await w.cli(['run', 'jane/orb-breakout', '--on', 'BTC', '--tf', '5m', '--last', '7d']);
    assert.equal(r.code, 4);
    assert.equal(r.stderr.trim(), 'error: not_in_library: jane/orb-breakout is not in your library.\nAdd it first: chartnaut library add jane/orb-breakout');
    assert.equal(w.api.calls('POST /runs').length, 1);
  });
});
