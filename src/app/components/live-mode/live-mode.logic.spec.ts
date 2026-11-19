import * as assert from 'assert';
import { analyzeReloads, evaluateFlags, joinTimeMs, playheadPdtMs, sparklinePoints, summarizePlaylist } from './live-mode.logic';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const playlist = (seq: number, count: number, opts: { endList?: boolean; pdtOfFirst?: number; dur?: number } = {}) => {
  const dur = opts.dur ?? 6;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  for (let i = 0; i < count; i++) {
    if (opts.pdtOfFirst !== undefined && i === 0) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(opts.pdtOfFirst).toISOString()}`);
    }
    lines.push(`#EXTINF:${dur.toFixed(3)},`, `seg${seq + i}.ts?hdntl=SECRET`);
  }
  if (opts.endList) {
    lines.push('#EXT-X-ENDLIST');
  }
  return lines.join('\n');
};

// summarize: live, PDT of newest segment derived from first tag + durations
{
  const s = summarizePlaylist(playlist(100, 5, { pdtOfFirst: T0 }))!;
  assert.strictEqual(s.mediaSequence, 100);
  assert.strictEqual(s.segmentCount, 5);
  assert.strictEqual(s.targetDuration, 6);
  assert.strictEqual(s.endList, false);
  assert.strictEqual(s.lastSegStartPdtMs, T0 + 24000);
  assert.ok(!JSON.stringify(s).includes('SECRET'));
  assert.strictEqual(summarizePlaylist(playlist(0, 3, { endList: true }))!.endList, true);
  assert.strictEqual(summarizePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8'), undefined);
  assert.strictEqual(summarizePlaylist(''), undefined);
}

// healthy: reload every 6 s, one new segment each time
const rec = (tReq: number, seq: number, level = 0, pdtFirst = T0 + (seq - 100) * 6000) => ({
  tRequest: tReq,
  tLoaded: tReq + 50,
  level,
  playlist: summarizePlaylist(playlist(seq, 5, { pdtOfFirst: pdtFirst }))!,
});
{
  // wall = perf + offset; head segment ends 10 s before wall at load
  const records = [rec(1000, 100), rec(7000, 101), rec(13000, 102), rec(19000, 103)];
  const offset = T0 + 24000 + 6000 + 10000 - 1050; // lag at first load = 10 s
  const a = analyzeReloads(records, offset);
  assert.strictEqual(a.isLive, true);
  assert.strictEqual(a.rows.length, 4);
  assert.strictEqual(a.avgIntervalMs, 6000);
  assert.strictEqual(a.rows[1].newSegments, 1);
  assert.strictEqual(a.rows[1].seqAdvance, 1);
  assert.strictEqual(a.staleInARow, 0);
  assert.ok(Math.abs(a.rows[0].availabilityLagSec! - 10) < 0.01);
  assert.ok(Math.abs(a.driftSecPerMin!) < 0.01); // 6 s segment per 6 s reload: no drift
  assert.deepStrictEqual(evaluateFlags(a, 12), []);
  assert.strictEqual(evaluateFlags(a, 19)[0].id, 'latency-high'); // > 3 x 6
}

// stale reloads in a row + slow refresh; other level is ignored
{
  const records = [rec(1000, 100), rec(2000, 100, 1), rec(10000, 101), rec(20000, 101), rec(30000, 101)];
  const a = analyzeReloads(records.filter((r) => r.level === 0), 0);
  assert.strictEqual(a.staleInARow, 2);
  assert.strictEqual(a.staleTotal, 2);
  assert.ok(Math.abs(a.avgIntervalMs! - 29000 / 3) < 1);
  const ids = evaluateFlags(a).map((f) => f.id);
  assert.deepStrictEqual(ids, ['refresh-slow', 'stale-reloads']);
  const mixed = analyzeReloads(records, 0); // latest request is level 0, so level 1 is dropped
  assert.strictEqual(mixed.rows.length, 4);
}

// drift: lag grows 2 s per minute
{
  const records = [rec(0, 100), rec(60000, 110)];
  records[1].playlist = summarizePlaylist(playlist(110, 5, { pdtOfFirst: T0 + 60000 - 2000 + 0 }))!;
  const a = analyzeReloads(records, T0 + 30000);
  assert.ok(a.driftSecPerMin! > 0);
}

// VOD
{
  const a = analyzeReloads([{ tRequest: 0, tLoaded: 10, level: 0, playlist: summarizePlaylist(playlist(0, 4, { endList: true }))! }], 0);
  assert.strictEqual(a.isLive, false);
  assert.deepStrictEqual(evaluateFlags(a, 99), []);
  assert.strictEqual(analyzeReloads([], 0).isLive, undefined);
}

// playhead PDT and join time
{
  const frags = [
    { start: 0, duration: 6, programDateTime: T0 },
    { start: 6, duration: 6, programDateTime: T0 + 6000 },
    { start: 12, duration: 6, programDateTime: null },
  ];
  assert.strictEqual(playheadPdtMs(frags, 7.5), T0 + 7500);
  assert.strictEqual(playheadPdtMs(frags, 13), undefined);
  assert.strictEqual(joinTimeMs(1000, 3500), 2500);
  assert.strictEqual(joinTimeMs(undefined, 3500), undefined);
}

// sparkline
{
  assert.strictEqual(sparklinePoints([{ t: 0, latencySec: 1 }], 100, 20), '');
  assert.strictEqual(sparklinePoints([{ t: 0, latencySec: 0 }, { t: 10, latencySec: 10 }], 100, 20), '0.0,20.0 100.0,0.0');
}

console.log('live-mode.logic.spec: ok');
