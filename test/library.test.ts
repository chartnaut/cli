import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const root = { ref: 'jane/orb-breakout', kind: 'definition', name: 'ORB breakout', author: 'jane', status: 'installable' };
const needs = [
  { ref: 'jane/session-range', kind: 'indicator', name: 'Session range', author: 'jane', status: 'installable' },
  { ref: 'sam/atr-bands', kind: 'indicator', name: 'ATR bands', author: 'sam', status: 'installable' },
  { ref: 'chartnaut/atr', kind: 'indicator', name: 'ATR', author: 'chartnaut', status: 'builtin' },
];
const withDeps = { root, needs, cannot_add: [], truncated: false, confirm: ['jane/session-range', 'sam/atr-bands'], message: 'To use ORB breakout, we will add 2 more scripts.' };
const noDeps = { root, needs: [], cannot_add: [], truncated: false, confirm: [], message: '' };
const added = { added: true, root, added_with: ['jane/session-range', 'sam/atr-bands'], skipped: [] };

const REQ = 'GET /library/jane/orb-breakout/requirements';
const ADD = 'POST /library/jane/orb-breakout';
const adds = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.method === 'POST');

test('library add with nothing else needed adds at once, without asking', async () => {
  const h = harness({ [REQ]: { json: noDeps }, [ADD]: { status: 201, json: { added: true, root, added_with: [], skipped: [] } } });
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout'), 0, h.err());
  assert.deepEqual(h.asked, []);
  assert.deepEqual(adds(h)[0]!.body, { confirm: [] });
  assert.match(h.out(), /^Added ORB breakout \(jane\/orb-breakout\) to your library\.$/m);
  assert.match(h.out(), /^Run it: chartnaut run jane\/orb-breakout$/m);
  assert.doesNotMatch(h.out(), /Also added/);
});

test('library add shows what it will add and asks; yes adds with confirm = requirements.confirm', async () => {
  for (const answer of ['y', 'Y', 'yes', ' YES ']) {
    const h = harness({ [REQ]: { json: withDeps }, [ADD]: { status: 201, json: added } }, { answers: [answer] });
    assert.equal(await h.run('library', 'add', 'jane/orb-breakout'), 0, h.err());
    const out = h.out();
    assert.match(out, /^To use ORB breakout, we'll add 2 more scripts to your library:$/m);
    assert.match(out, /^REF\s+KIND\s+AUTHOR$/m);
    assert.match(out, /^jane\/session-range\s+indicator\s+jane$/m);
    assert.match(out, /^sam\/atr-bands\s+indicator\s+sam$/m);
    assert.doesNotMatch(out, /chartnaut\/atr/, 'a built-in is not something we add');
    assert.match(out, /^They stay yours, and you can remove them whenever you like\.$/m);
    assert.deepEqual(h.asked, ['Add them? [y/N] ']);
    assert.deepEqual(adds(h)[0]!.body, { confirm: ['jane/session-range', 'sam/atr-bands'] });
    assert.match(out, /^Also added: jane\/session-range, sam\/atr-bands$/m);
  }
});

test('library add: anything but yes adds nothing and exits 4', async () => {
  for (const answer of ['', 'n', 'no', 'maybe']) {
    const h = harness({ [REQ]: { json: withDeps }, [ADD]: { status: 201, json: added } }, { answers: [answer] });
    assert.equal(await h.run('library', 'add', 'jane/orb-breakout'), 4, JSON.stringify(answer));
    assert.equal(adds(h).length, 0);
    assert.match(h.err(), /Nothing was added\./);
  }
});

test('library add --yes agrees without asking', async () => {
  const h = harness({ [REQ]: { json: withDeps }, [ADD]: { status: 201, json: added } });
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout', '--yes'), 0, h.err());
  assert.deepEqual(h.asked, []);
  assert.deepEqual(adds(h)[0]!.body, { confirm: ['jane/session-range', 'sam/atr-bands'] });
  assert.match(h.out(), /we'll add 2 more scripts/, 'the list is still printed');
});

test('library add with no terminal and no --yes refuses with exit 4 and adds nothing', async () => {
  const h = harness({ [REQ]: { json: withDeps }, [ADD]: { status: 201, json: added } });
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout'), 4);
  assert.equal(adds(h).length, 0);
  assert.match(h.out(), /we'll add 2 more scripts/);
  assert.match(h.err(), /^error: confirmation_required: adding jane\/orb-breakout also adds 2 scripts to your library\. Agree with the user first, then run it again with --yes\.$/m);
});

test('library add with scripts that are not shared lists them and exits 4 without asking', async () => {
  const req = { ...noDeps, cannot_add: [{ kind: 'indicator', name: 'Private bands' }, { kind: 'definition', name: 'Secret sauce' }], confirm: [] };
  const h = harness({ [REQ]: { json: req }, [ADD]: { status: 201, json: added } }, { answers: ['y'] });
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout'), 4);
  assert.deepEqual(h.asked, []);
  assert.equal(adds(h).length, 0);
  assert.match(h.out(), /^ORB breakout can't be added: it uses 2 scripts that aren't shared with you:$/m);
  assert.match(h.out(), /^Private bands\s+indicator$/m);
  assert.match(h.out(), /^Secret sauce\s+definition$/m);
  assert.match(h.err(), /^error: not_shared: nothing was added/m);
});

test('library add when the script is already usable prints the reason and exits 0', async () => {
  const h = harness({ [REQ]: { json: { ...noDeps, root: { ...root, status: 'installed' } } }, [ADD]: { status: 200, json: { added: false, root, reason: 'It is already in your library.' } } });
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout'), 0, h.err());
  assert.equal(h.out(), 'Nothing to add: It is already in your library.');
});

test('library add --json prints the API JSON; the list goes to stderr; --kind is sent', async () => {
  const h = harness({ [REQ]: { json: withDeps }, [ADD]: { status: 201, json: added } });
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout', '--yes', '--kind', 'definition', '--json'), 0, h.err());
  assert.deepEqual(JSON.parse(h.out()), added);
  assert.match(h.err(), /we'll add 2 more scripts/);
  for (const c of h.calls) assert.equal(c.url.searchParams.get('kind'), 'definition');
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout', '--kind', 'study'), 4, 'studies cannot be added');
});

test('library add: a race the server catches (confirmation_required) and a study (not_installable) exit 4', async () => {
  const h = harness({
    [REQ]: { json: noDeps },
    [ADD]: { status: 409, json: { error: { code: 'confirmation_required', message: 'Adding this also adds scripts you have not agreed to.', details: { needs, confirm: ['jane/session-range'], missing: ['jane/session-range'] } } } },
  });
  assert.equal(await h.run('library', 'add', 'jane/orb-breakout'), 4);
  assert.match(h.err(), /^error: confirmation_required: /m);
  assert.match(h.err(), /^ {2}not agreed: jane\/session-range$/m);
  const s = harness({ 'GET /library/jane/my-study/requirements': { status: 409, json: { error: { code: 'not_installable', message: 'Only your own studies run.' } } } });
  assert.equal(await s.run('library', 'add', 'jane/my-study'), 4);
  assert.match(s.err(), /not_installable: Only your own studies run\./);
});

test('library add/remove/needs refuse a ref that is not author/slug before any request', async () => {
  const h = harness();
  for (const ref of ['orb', 'jane/orb@3', 'a/b/c', '/orb']) {
    for (const sub of ['add', 'remove', 'needs']) {
      assert.equal(await h.run('library', sub, ref), 4, `${sub} ${ref}`);
    }
  }
  assert.equal(h.calls.length, 0);
});

test('library remove sends DELETE with --kind and reports; 404 and 409 exit 4', async () => {
  const h = harness({ 'DELETE /library/jane/orb-breakout': { json: { removed: true, ref: 'jane/orb-breakout', kind: 'definition' } } });
  assert.equal(await h.run('library', 'remove', 'jane/orb-breakout', '--kind', 'definition'), 0, h.err());
  assert.equal(h.calls[0]!.method, 'DELETE');
  assert.equal(h.calls[0]!.url.searchParams.get('kind'), 'definition');
  assert.match(h.out(), /^Removed jane\/orb-breakout \(definition\) from your library\. Scripts added with it stay; remove them the same way\.$/m);
  assert.equal(await h.run('library', 'remove', 'jane/orb-breakout', '--json'), 0);
  assert.deepEqual(JSON.parse(h.stdout.at(-1)!), { removed: true, ref: 'jane/orb-breakout', kind: 'definition' });

  const nf = harness({ 'DELETE /library/jane/nope': { status: 404, json: { error: { code: 'not_found', message: 'jane/nope is not in your library.' } } } });
  assert.equal(await nf.run('library', 'remove', 'jane/nope'), 4);
  const both = harness({ 'DELETE /library/jane/orb': { status: 409, json: { error: { code: 'conflict', message: 'Both an indicator and a definition match. Pass kind.' } } } });
  assert.equal(await both.run('library', 'remove', 'jane/orb'), 4);
  assert.match(both.err(), /Pass kind/);
});

test('library needs (alias requirements) lists without adding', async () => {
  const h = harness({ [REQ]: { json: withDeps } });
  assert.equal(await h.run('library', 'needs', 'jane/orb-breakout'), 0, h.err());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.method, 'GET');
  const out = h.out();
  assert.match(out, /^jane\/orb-breakout {2}definition {2}installable {2}ORB breakout$/m);
  assert.match(out, /^Adding it also adds 2 scripts to your library:$/m);
  assert.match(out, /^REF\s+KIND\s+AUTHOR\s+STATUS$/m);
  assert.match(out, /^chartnaut\/atr\s+indicator\s+chartnaut\s+builtin$/m);
  assert.match(out, /^Add it: chartnaut library add jane\/orb-breakout$/m);
  assert.deepEqual(h.asked, []);

  assert.equal(await h.run('library', 'requirements', 'jane/orb-breakout', '--json'), 0);
  assert.deepEqual(JSON.parse(h.stdout.at(-1)!), withDeps);
  assert.equal(h.calls.every((c) => c.method === 'GET'), true);

  const none = harness({ [REQ]: { json: { ...noDeps, cannot_add: [{ kind: 'indicator', name: 'Private bands' }] } } });
  assert.equal(await none.run('library', 'needs', 'jane/orb-breakout'), 0);
  assert.match(none.out(), /It needs no other scripts\./);
  assert.match(none.out(), /can't be added: it uses 1 script that isn't shared with you:/);
  assert.doesNotMatch(none.out(), /Add it:/);
});

test('run author/slug not in the library: the API message plus the library add command', async () => {
  const h = harness({
    'POST /runs': {
      status: 409,
      json: { error: { code: 'not_in_library', message: 'jane/orb-breakout is not in your library.', details: { ref: 'jane/orb-breakout', add: 'POST /library/jane/orb-breakout', needs, cannot_add: [], confirm: ['jane/session-range'] } } },
    },
  });
  assert.equal(await h.run('run', 'jane/orb-breakout', '--on', 'BTC', '--tf', '5m', '--last', '7d'), 4);
  assert.equal(h.err(), 'error: not_in_library: jane/orb-breakout is not in your library.\nAdd it first: chartnaut library add jane/orb-breakout');
  assert.equal(h.calls.length, 1, 'a 409 is not retried');
  assert.equal(await h.run('run', 'jane/orb-breakout', '--on', 'BTC', '--tf', '5m', '--last', '7d', '--json'), 4);
  assert.equal(JSON.parse(h.stdout.at(-1)!).error.code, 'not_in_library');
});

test('a study run whose definitions are not in the library: one add line per definition; not_shared lists names', async () => {
  const h = harness({
    'POST /runs': {
      status: 409,
      json: {
        error: {
          code: 'not_in_library',
          message: 'This study uses definitions that are not in your library.',
          details: { definitions: [{ ref: 'jane/orb-breakout', needs: [] }, { ref: 'sam/vwap-touch', needs: [] }, { ref: 'bad ref; rm -rf' }] },
        },
      },
    },
  });
  assert.equal(await h.run('run', 'my-study', '--on', 'BTC', '--tf', '5m', '--last', '7d'), 4);
  assert.match(h.err(), /^Add it first: chartnaut library add jane\/orb-breakout$/m);
  assert.match(h.err(), /^Add it first: chartnaut library add sam\/vwap-touch$/m);
  assert.doesNotMatch(h.err(), /rm -rf/, 'only a plain author/slug goes into a command line');

  const ns = harness({
    'POST /runs': { status: 409, json: { error: { code: 'not_shared', message: 'jane/orb-breakout uses scripts that are not shared with you.', details: { cannot_add: [{ kind: 'indicator', name: 'Private bands' }] } } } },
  });
  assert.equal(await ns.run('run', 'jane/orb-breakout', '--on', 'BTC', '--tf', '5m', '--last', '7d'), 4);
  assert.match(ns.err(), /^ {2}not shared with you: Private bands \(indicator\)$/m);
});

test('the not_in_library hint also prints per instrument on a fan-out', async () => {
  const h = harness({
    'POST /runs': { status: 409, json: { error: { code: 'not_in_library', message: 'jane/orb-breakout is not in your library.', details: { ref: 'jane/orb-breakout' } } } },
  });
  assert.equal(await h.run('run', 'jane/orb-breakout', '--on', 'BTC,ETH', '--tf', '5m', '--last', '7d'), 4);
  assert.match(h.err(), /^BTC: Add it first: chartnaut library add jane\/orb-breakout$/m);
  assert.match(h.err(), /^ETH: Add it first: chartnaut library add jane\/orb-breakout$/m);
});
