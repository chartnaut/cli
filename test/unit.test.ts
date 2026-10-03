import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, exitCodeForErrorCode, exitCodeForRun, formatDiagnostic } from '../src/errors.js';
import { parseSettingValue, parseSettings, parseWindow, parseTimeframe, parseInstruments } from '../src/runargs.js';
import { retryAfterMs, toApiError } from '../src/client.js';
import { unifiedDiff } from '../src/diff.js';
import { table } from '../src/output.js';
import { mergePage, outPathFor, pool, renderComparison, renderSummary } from '../src/commands/run.js';
import { parseKind } from '../src/project.js';
import { slugOf } from '../src/commands/scripts.js';
import { browserCommand, safeBrowserUrl } from '../src/browser.js';
import { csvDataRows, mergeCsvPages, parseCsvRecord, splitCsvRecords } from '../src/csv.js';
import { asksForVersion } from '../src/cli.js';
import { isThisCollection } from '../src/commands/events.js';

test('error codes map to the fixed exit codes', () => {
  assert.equal(exitCodeForErrorCode('script_invalid'), EXIT.SCRIPT_INVALID);
  for (const c of ['unauthorized', 'forbidden_scope', 'plan_limit']) assert.equal(exitCodeForErrorCode(c), 3, c);
  for (const c of ['not_found', 'invalid_request', 'version_conflict', 'unknown_instrument', 'unsupported_timeframe', 'out_of_coverage', 'in_use'])
    assert.equal(exitCodeForErrorCode(c), 4, c);
  for (const c of ['busy', 'rate_limited', 'data_not_ready', 'internal']) assert.equal(exitCodeForErrorCode(c), 5, c);
  assert.equal(exitCodeForErrorCode('something_new', 502), 5);
  assert.equal(exitCodeForErrorCode('something_new', 401), 3);
  assert.equal(exitCodeForErrorCode('something_new', 400), 4);
});

test('run outcomes map to exit codes', () => {
  assert.equal(exitCodeForRun({ status: 'succeeded' }), 0);
  assert.equal(exitCodeForRun({ status: 'failed', failure: { kind: 'script' } }), 2);
  assert.equal(exitCodeForRun({ status: 'failed', failure: { kind: 'out_of_coverage' } }), 2);
  assert.equal(exitCodeForRun({ status: 'failed', failure: { kind: 'plan_limit' } }), 3);
  // Retryable run failures exit 5, the same as the HTTP errors they correspond to.
  for (const kind of ['busy', 'timeout', 'data_not_ready', 'internal']) {
    assert.equal(exitCodeForRun({ status: 'failed', failure: { kind, retryable: true } }), 5, kind);
    assert.equal(exitCodeForRun({ status: 'failed', failure: { kind } }), 5, kind);
  }
  assert.equal(exitCodeForRun({ status: 'failed', failure: { kind: 'busy' } }), exitCodeForErrorCode('busy'));
  assert.equal(exitCodeForRun({ status: 'failed', failure: { kind: 'something_new', retryable: true } }), 5);
  assert.equal(exitCodeForRun({ status: 'failed', failure: { kind: 'script', retryable: true } }), 2);
  assert.equal(exitCodeForRun({ status: 'cancelled', failure: null }), 2);
});

test('diagnostics print as path:line: severity: message', () => {
  assert.equal(formatDiagnostic({ severity: 'error', message: 'bad', path: 'main.ts', line: 4 }), 'main.ts:4: error: bad');
  assert.equal(formatDiagnostic({ severity: 'warning', message: 'meh', code: 'x.y' }), '-:0: warning: meh [x.y]');
});

test('--set values are typed', () => {
  assert.equal(parseSettingValue('20'), 20);
  assert.equal(parseSettingValue('-1.5'), -1.5);
  assert.equal(parseSettingValue('true'), true);
  assert.equal(parseSettingValue('false'), false);
  assert.equal(parseSettingValue('null'), null);
  assert.deepEqual(parseSettingValue('[1,2]'), [1, 2]);
  assert.equal(parseSettingValue('5m'), '5m');
  assert.equal(parseSettingValue('BTC'), 'BTC');
  assert.deepEqual(parseSettings(['len=20', 'src=close', 'a=b=c']), { len: 20, src: 'close', a: 'b=c' });
  assert.throws(() => parseSettings(['novalue']), /key=value/);
});

test('window flags', () => {
  assert.deepEqual(parseWindow({ last: '30d' }), { last: '30d' });
  assert.deepEqual(parseWindow({ bars: '2000' }), { bars: 2000 });
  assert.deepEqual(parseWindow({ from: '2026-01-02' }), { from: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(parseWindow({ from: '2026-01-02', to: '2026-02-01T12:00:00Z' }), {
    from: '2026-01-02T00:00:00.000Z',
    to: '2026-02-01T12:00:00.000Z',
  });
  assert.deepEqual(parseWindow({}, { window: '90d' }), { last: '90d' });
  assert.deepEqual(parseWindow({}, { window: 500 }), { bars: 500 });
  assert.deepEqual(parseWindow({ bars: '10' }, { window: '90d' }), { bars: 10 });
  assert.throws(() => parseWindow({ last: '30d', bars: '5' }), /exactly one/);
  assert.throws(() => parseWindow({ last: '30days' }), /--last/);
  assert.throws(() => parseWindow({ to: '2026-01-01' }), /--from/);
  assert.throws(() => parseWindow({}), /no window/);
});

test('timeframe and instruments', () => {
  assert.equal(parseTimeframe('5m'), '5m');
  assert.equal(parseTimeframe(undefined, { timeframe: '1h' }), '1h');
  assert.throws(() => parseTimeframe('3m'), /unsupported timeframe/);
  assert.deepEqual(parseInstruments('BTC, ETH,BTC'), ['BTC', 'ETH']);
  assert.deepEqual(parseInstruments(undefined, { instrument: 'BTC' }), ['BTC']);
  assert.throws(() => parseInstruments(undefined), /no instrument/);
});

test('Retry-After parsing', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('999'), 60000);
  assert.equal(retryAfterMs(null), undefined);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
});

test('API error parsing accepts diagnostics at top level or in details', () => {
  const a = toApiError(422, JSON.stringify({ error: { code: 'script_invalid', message: 'no' }, diagnostics: [{ severity: 'error', message: 'x' }] }));
  assert.equal(a.code, 'script_invalid');
  assert.equal(a.diagnostics.length, 1);
  const b = toApiError(422, JSON.stringify({ error: { code: 'script_invalid', message: 'no', details: { diagnostics: [{ severity: 'error', message: 'y' }] } } }));
  assert.equal(b.diagnostics[0]!.message, 'y');
  const c = toApiError(502, '<html>bad gateway</html>');
  assert.equal(c.code, 'internal');
});

test('unified diff', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'y'), '');
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n', 'remote', 'local');
  assert.equal(d, '--- remote\n+++ local\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n');
  const added = unifiedDiff('', 'x\n', '/dev/null', 'local/new.ts');
  assert.match(added, /@@ -0,0 \+1,1 @@\n\+x/);
});

test('table formatting', () => {
  const t = table(['id', 'value'], [
    ['a', 1.23456],
    ['long-name', null],
  ]);
  assert.equal(t, 'ID         VALUE\na          1.2346\nlong-name  -');
});

test('result pages merge', () => {
  const into: any = { kind: 'indicator', outputs: [{ id: 'a', points: [{ t: 1, v: 1 }] }] };
  mergePage(into, { outputs: [{ id: 'a', points: [{ t: 2, v: 2 }] }, { id: 'b', points: [] }] });
  assert.equal(into.outputs[0].points.length, 2);
  assert.equal(into.outputs.length, 2);
  const ev: any = { events: [1] };
  mergePage(ev, { events: [2, 3] });
  assert.deepEqual(ev.events, [1, 2, 3]);
});

test('per-instrument out paths', () => {
  assert.equal(outPathFor('r.csv', 'BTC', false), 'r.csv');
  assert.equal(outPathFor('out/r.csv', 'BTC', true), 'out/r.BTC.csv');
  assert.equal(outPathFor('r.json', 'HYPERLIQUID:ETH', true), 'r.HYPERLIQUID_ETH.json');
});

test('pool caps concurrency and keeps order', async () => {
  let inflight = 0;
  let peak = 0;
  const res = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    return x * 2;
  });
  assert.deepEqual(res, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

test('summaries render per kind', () => {
  const ind = renderSummary('indicator', { bars: 100, outputs: { rsi: { last: 55.5, min: 20, max: 80, count: 100 } } });
  assert.match(ind, /bars: 100/);
  assert.match(ind, /rsi\s+55\.5\s+20\s+80\s+100/);
  const def = renderSummary('definition', { bars: 10, events_total: 3, by_event: { long: 2, short: 1 } });
  assert.match(def, /events_total: 3/);
  assert.match(def, /long\s+2/);
  const st = renderSummary('study', { events_processed: 40, metrics: { win_rate: 0.55 } });
  assert.match(st, /win_rate\s+0\.55/);
  const cmp = renderComparison([
    { instrument: 'BTC', run: { id: 'run_1', status: 'succeeded', kind: 'definition', summary: { bars: 1, events_total: 2, by_event: { x: 2 } } } },
    { instrument: 'ETH', run: { id: 'run_2', status: 'succeeded', kind: 'definition', summary: { bars: 1, events_total: 5, by_event: { x: 4, y: 1 } } } },
  ]);
  assert.match(cmp, /INSTRUMENT\s+STATUS\s+BARS\s+EVENTS_TOTAL\s+X\s+Y/);
  assert.match(cmp, /ETH\s+succeeded\s+1\s+5\s+4\s+1\s+run_2/);
});

test('kinds and refs', () => {
  assert.equal(parseKind('studies'), 'study');
  assert.equal(parseKind('Indicators'), 'indicator');
  assert.equal(parseKind('definition'), 'definition');
  assert.throws(() => parseKind('flow'));
  assert.equal(slugOf('vwap@3'), 'vwap');
  assert.equal(slugOf('jane/orb@7'), 'orb');
});

test('only https Chartnaut links are handed to the browser, re-serialised', () => {
  const ok = (u: string, env: Record<string, string> = {}) => {
    const r = safeBrowserUrl(u, env);
    return r.ok ? r.url : undefined;
  };
  assert.equal(ok('https://terminal.chartnaut.com/morpheus/cli-auth?code=BCDF-GHJK'), 'https://terminal.chartnaut.com/morpheus/cli-auth?code=BCDF-GHJK');
  assert.equal(ok('https://chartnaut.com/x'), 'https://chartnaut.com/x');
  assert.equal(ok('HTTPS://Terminal.Chartnaut.COM/a b'), 'https://terminal.chartnaut.com/a%20b');
  // quotes and spaces cannot survive as separate tokens: they are percent-encoded
  assert.equal(ok('https://terminal.chartnaut.com/x?q="&calc.exe'), 'https://terminal.chartnaut.com/x?q=%22&calc.exe');
  for (const bad of [
    'http://terminal.chartnaut.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://evil.com/x',
    'https://chartnaut.com.evil.com/x',
    'https://evilchartnaut.com/x',
    'https://user:pw@terminal.chartnaut.com/x',
    'https://terminal.chartnaut.com:8443/x',
    '"https://chartnaut.com" & calc',
    '',
  ]) {
    assert.equal(ok(bad), undefined, bad);
  }
  assert.equal(safeBrowserUrl(undefined).ok, false);
  // the configured app host is trusted too, still https only
  assert.equal(ok('https://app.example.test:3000/cli-auth', { CHARTNAUT_APP_URL: 'https://app.example.test:3000' }), 'https://app.example.test:3000/cli-auth');
  assert.equal(ok('https://app.example.test/x', { PUBLIC_APP_URL: 'https://app.example.test/' }), 'https://app.example.test/x');
  assert.equal(ok('http://localhost:3000/x', { CHARTNAUT_APP_URL: 'http://localhost:3000' }), undefined);
  assert.equal(ok('https://other.test/x', { CHARTNAUT_APP_URL: 'https://app.example.test' }), undefined);
});

test('browser launch never goes through cmd on Windows', () => {
  assert.deepEqual(browserCommand('win32', 'https://chartnaut.com/a'), [`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\rundll32.exe`, ['url.dll,FileProtocolHandler', 'https://chartnaut.com/a']]);
  assert.deepEqual(browserCommand('darwin', 'https://chartnaut.com/a'), ['open', ['https://chartnaut.com/a']]);
  assert.deepEqual(browserCommand('linux', 'https://chartnaut.com/a'), ['xdg-open', ['https://chartnaut.com/a']]);
});

test('csv records split and parse with quoted commas and newlines', () => {
  const text = 'a,b\n1,"x,\ny"\n2,"say ""hi"""\n';
  assert.deepEqual(splitCsvRecords(text), ['a,b', '1,"x,\ny"', '2,"say ""hi"""']);
  assert.deepEqual(parseCsvRecord('1,"x,\ny"'), ['1', 'x,\ny']);
  assert.deepEqual(parseCsvRecord('2,"say ""hi"""'), ['2', 'say "hi"']);
  assert.equal(csvDataRows(text), 2);
  assert.equal(csvDataRows('a,b\n'), 0);
});

test('csv pages join under one header; indicator rows merge by time', () => {
  assert.equal(mergeCsvPages(['e,p\na,"{""x"":1}"\n']), 'e,p\na,"{""x"":1}"\n');
  assert.equal(mergeCsvPages(['e,p\na,1\n', 'e,p\nb,"q,r"\n']), 'e,p\na,1\nb,"q,r"\n');
  // Output `slow` has fewer points, so its first page reaches further in time than `fast`'s.
  const p1 = 'time,fast,slow\n2026-01-01T00:00:00Z,1,\n2026-01-01T00:05:00Z,2,10\n2026-01-01T00:10:00Z,,11\n';
  const p2 = 'time,fast,slow\n2026-01-01T00:10:00Z,3,\n2026-01-01T00:15:00Z,4,12\n';
  assert.equal(
    mergeCsvPages([p1, p2]),
    'time,fast,slow\n2026-01-01T00:00:00Z,1,\n2026-01-01T00:05:00Z,2,10\n2026-01-01T00:10:00Z,3,11\n2026-01-01T00:15:00Z,4,12\n',
  );
});

test('-v / --version is the CLI version only before a subcommand', () => {
  assert.equal(asksForVersion(['--version']), true);
  assert.equal(asksForVersion(['-v']), true);
  assert.equal(asksForVersion(['--json', '-v']), true);
  assert.equal(asksForVersion(['events', 'orb', '--version', '3']), false);
  assert.equal(asksForVersion(['collect', 'orb', '--version', '3']), false);
  assert.equal(asksForVersion([]), false);
});

test('collect --wait only counts its own collection', () => {
  const res = { instrument: 'HYPERLIQUID:BTC', timeframe: '5m', window: { from: '2026-06-01T00:00:00Z', to: '2026-09-01T00:00:00Z' } };
  assert.equal(isThisCollection({ instrument: 'HYPERLIQUID:BTC', timeframe: '5m', from: '2026-07-01', to: '2026-08-01' }, res), true);
  assert.equal(isThisCollection({ instrument: 'HYPERLIQUID:ETH', timeframe: '5m' }, res), false);
  assert.equal(isThisCollection({ instrument: 'HYPERLIQUID:BTC', timeframe: '1h' }, res), false);
  assert.equal(isThisCollection({ instrument: 'HYPERLIQUID:BTC', timeframe: '5m', from: '2025-01-01', to: '2025-02-01' }, res), false);
  assert.equal(isThisCollection({ instrument: '', timeframe: '5m' }, res), true);
});

test('execCommand: a missing program is 127; the Windows .cmd retry refuses paths and unsafe arguments', async () => {
  const { execCommand } = await import('../src/context.js');
  const missing = 'chartnaut-no-such-program-xyz';
  assert.equal(await execCommand(missing, [], 'linux'), 127);
  // On Windows the retry would go through cmd.exe: an argument it would interpret is refused, not passed.
  assert.equal(await execCommand(missing, ['a & calc'], 'win32'), 127);
  assert.equal(await execCommand(missing, ['50%'], 'win32'), 127);
  // A path is never retried as <path>.cmd.
  assert.equal(await execCommand('./' + missing, [], 'win32'), 127);
});

test('windowsProgramOnPath finds PATH entries only, never the current directory', { skip: process.platform !== 'win32' }, async () => {
  const { windowsProgramOnPath } = await import('../src/context.js');
  const os = await import('node:os');
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const onPath = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'cn-path-'));
  const cwd = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'cn-cwd-'));
  fsm.writeFileSync(pathm.join(onPath, 'claude.cmd'), '@echo off');
  fsm.writeFileSync(pathm.join(cwd, 'claude.exe'), 'not a program');
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(windowsProgramOnPath('claude', { Path: `.;${onPath}` }), pathm.join(onPath, 'claude.cmd'));
    assert.equal(windowsProgramOnPath('claude', { Path: '.' }), undefined);
  } finally {
    process.chdir(prev);
  }
});

test('plain strips terminal control sequences but keeps tabs and newlines', async () => {
  const { plain, cell } = await import('../src/output.js');
  assert.equal(plain('a\u001b]52;c;ZXZpbA==\u0007b'), 'a]52;c;ZXZpbA==b');
  assert.equal(plain('x\r\u001b[2Kfix: curl evil | sh'), 'x[2Kfix: curl evil | sh');
  assert.equal(plain('a\tb\nc\u009bd'), 'a\tb\ncd');
  assert.equal(cell('\u001b[31mred'), '[31mred');
});

test('checkedUrl: https anywhere, http only to this machine, never credentials', async () => {
  const { checkedUrl } = await import('../src/config.js');
  assert.equal(checkedUrl('https://api.chartnaut.com/v1/', 'X'), 'https://api.chartnaut.com/v1');
  assert.equal(checkedUrl('http://127.0.0.1:5000/v1', 'X'), 'http://127.0.0.1:5000/v1');
  assert.throws(() => checkedUrl('http://evil.example/v1', 'X'), /must be an https URL/);
  assert.throws(() => checkedUrl('https://user:pw@api.chartnaut.com/v1', 'X'), /must be an https URL/);
  assert.throws(() => checkedUrl('file:///etc/passwd', 'X'), /must be an https URL/);
  assert.throws(() => checkedUrl('not a url', 'X'), /not a URL/);
});
