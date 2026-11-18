import * as assert from 'assert';
import { buildAudit, mediaStats, toTsv, AuditRecord } from './bitrate-audit.logic';

// 6s segments of `kbps` bitrate
const seg = (n: number, level: number, kbps: number, extra: Partial<AuditRecord> = {}): AuditRecord => ({
  url: `https://x/v${level}/seg${n}.ts`, kind: 'video-segment', level, bytes: (kbps * 1000 * 6) / 8, durationSec: 6, ...extra,
});
const variant = (level: number, bw: number, avg: number, extra: Partial<AuditRecord> = {}): AuditRecord => ({
  url: `https://x/v${level}.m3u8`, kind: 'variant', level, bandwidthDeclared: bw, averageBandwidthDeclared: avg,
  resolution: '1920x1080', ...extra,
});

// muxed TS, understated AVERAGE-BANDWIDTH: 2760 vs 2322 declared -> 118.9% -> flagged
{
  const recs = [variant(0, 3000000, 2322000), ...[1, 2, 3, 4].map((n) => seg(n, 0, 2760))];
  const { video, audio } = buildAudit(recs);
  assert.strictEqual(video.length, 1);
  assert.strictEqual(audio.length, 0);
  const r = video[0];
  assert.strictEqual(Math.round(r.avgKbps as number), 2760);
  assert.strictEqual(r.segments, 4);
  assert.strictEqual(r.seconds, 24);
  assert.strictEqual(r.isTs, true);
  assert.ok(Math.abs((r.avgPct as number) - 118.9) < 0.2);
  assert.strictEqual(r.flagAvg, true);
  assert.strictEqual(r.flagPeak, false);
  assert.strictEqual(r.isFewSegments, false);
  assert.strictEqual(r.combinedAvgKbps, undefined);
}

// exactly 10% over is not flagged; just above is
{
  const at = buildAudit([variant(0, 9e6, 1000000), ...[1, 2, 3].map((n) => seg(n, 0, 1100))]).video[0];
  assert.strictEqual(at.flagAvg, false);
  const over = buildAudit([variant(0, 9e6, 1000000), ...[1, 2, 3].map((n) => seg(n, 0, 1101))]).video[0];
  assert.strictEqual(over.flagAvg, true);
}

// peak above BANDWIDTH flags; peak is max per-segment
{
  const recs = [variant(0, 2000000, 1800000), seg(1, 0, 1500), seg(2, 0, 2500), seg(3, 0, 1500)];
  const r = buildAudit(recs).video[0];
  assert.strictEqual(Math.round(r.peakKbps as number), 2500);
  assert.strictEqual(r.flagPeak, true);
  assert.strictEqual(r.flagAvg, false);
}

// separate audio: declared includes audio, so combined drives the flag
{
  const aud = (n: number): AuditRecord => ({
    url: `https://x/a/seg${n}.ts`, kind: 'audio-segment', audioGroup: 'aud', trackName: 'English', bytes: (128000 * 6) / 8, durationSec: 6,
  });
  const recs = [variant(0, 3000000, 2000000, { audioGroup: 'aud' }), ...[1, 2, 3].map((n) => seg(n, 0, 1900)), ...[1, 2, 3].map(aud)];
  const { video, audio } = buildAudit(recs);
  assert.strictEqual(audio.length, 1);
  assert.strictEqual(Math.round(audio[0].avgKbps as number), 128);
  const r = video[0];
  assert.strictEqual(Math.round(r.combinedAvgKbps as number), 2028);
  assert.strictEqual(r.flagAvg, false); // 2028 < 2200
  const videoSegs = [1, 2, 3].map((n) => seg(n, 0, 1900));
  const heavier = buildAudit([variant(0, 3000000, 1800000, { audioGroup: 'aud' }), ...videoSegs, ...[1, 2, 3].map(aud)]).video[0];
  assert.strictEqual(heavier.flagAvg, true); // 2028 > 1980, video alone (1900) would not be
}

// missing bytes / zero duration / errors ignored; no NaN
{
  const recs = [
    variant(0, 1e6, 9e5),
    { ...seg(1, 0, 800), bytes: undefined }, { ...seg(2, 0, 800), durationSec: 0 }, { ...seg(3, 0, 800), error: 'x' }, seg(4, 0, 800),
  ];
  const r = buildAudit(recs).video[0];
  assert.strictEqual(r.segments, 1);
  assert.strictEqual(r.isFewSegments, true);
  assert.strictEqual(Math.round(r.avgKbps as number), 800);
  const none = buildAudit([variant(1, 1e6, 9e5), { ...seg(1, 1, 800), bytes: undefined }]).video[0];
  assert.strictEqual(none.avgKbps, undefined);
  assert.strictEqual(none.avgPct, undefined);
  assert.strictEqual(none.flagAvg, false);
  assert.strictEqual(mediaStats([]).avgKbps, undefined);
}

// re-download of same URL counted once; missing declared values give no flag
{
  const r = buildAudit([seg(1, 0, 1000), seg(1, 0, 1000), seg(2, 0, 1000)]).video[0];
  assert.strictEqual(r.segments, 2);
  assert.strictEqual(r.flagAvg, false);
  assert.strictEqual(r.bandwidthKbps, undefined);
}

// fMP4 not tagged TS; TSV shape
{
  const res = buildAudit([variant(0, 3e6, 2e6), ...[1, 2, 3].map((n) => seg(n, 0, 2400, { url: `https://x/s${n}.m4s?a=1` }))]);
  assert.strictEqual(res.video[0].isTs, false);
  const lines = toTsv(res).split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].split('\t').length, lines[1].split('\t').length);
  assert.ok(lines[1].includes('avg>110%'));
}
console.log('bitrate-audit.logic: all tests passed');
