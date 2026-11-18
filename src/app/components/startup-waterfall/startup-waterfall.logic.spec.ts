import * as assert from 'assert';
import { computeStartup, toJson } from './startup-waterfall.logic';

const rec = (kind: string, tRequest: number, tFirstByte?: number, tLoaded?: number, extra: any = {}) => ({
  url: kind + tRequest,
  kind,
  tRequest,
  tFirstByte,
  tLoaded,
  ...extra,
});

// 1. muxed TS, no separate audio. perf times offset by 1000.
{
  const r = computeStartup(
    [
      rec('master', 1000, 1040, 1050),
      rec('variant', 1060, 1090, 1100, { resolution: '640x360', bandwidthDeclared: 800000 }),
      rec('video-segment', 1110, 1200, 1500, { resolution: '640x360', bandwidthDeclared: 800000, bytes: 500000 }),
      rec('variant', 5000, 5010, 5020, { resolution: '1920x1080', bandwidthDeclared: 6000000 }),
    ],
    1000
  );
  assert.strictEqual(r.joinMs, 500);
  assert.strictEqual(r.masterTtfbMs, 40);
  assert.strictEqual(r.isComplete, true);
  assert.deepStrictEqual(r.rows.map((x) => x.key), ['master', 'variant', 'video']);
  assert.strictEqual(r.rows[2].ttfbMs, 90);
  assert.strictEqual(r.rows[2].downloadMs, 390);
  assert.strictEqual(r.startedOnRung, '640x360');
  assert.strictEqual(r.ladderKnown, true);
  assert.strictEqual(r.isTopRung, false);
}

// 2. fMP4 with init + separate audio: join is max of video and audio ends; pending until audio lands.
{
  const base = [
    rec('master', 0, 10, 20),
    rec('variant', 30, 40, 50, { level: 1, bandwidthDeclared: 3000000, resolution: '1280x720' }),
    rec('audio-playlist', 30, 45, 55),
    rec('init', 60, 70, 80),
    rec('init', 60, 72, 85),
    rec('video-segment', 90, 150, 400, { bandwidthDeclared: 3000000, resolution: '1280x720', bytes: 2e6 }),
  ];
  const pending = computeStartup(base, 0);
  assert.strictEqual(pending.isComplete, false);
  assert.strictEqual(pending.joinMs, undefined);
  const done = computeStartup([...base, rec('audio-segment', 90, 120, 600, { bytes: 90000 })], 0);
  assert.strictEqual(done.joinMs, 600);
  assert.deepStrictEqual(done.rows.map((x) => x.key), ['master', 'variant', 'audio-playlist', 'init0', 'init1', 'video', 'audio']);
}

// 3. missing tFirstByte: whole bar is transfer, no ttfb; still computes join.
{
  const r = computeStartup([rec('master', 100, undefined, 130), rec('video-segment', 140, undefined, 300)], 100);
  assert.strictEqual(r.masterTtfbMs, undefined);
  assert.strictEqual(r.rows[0].firstByteMs, undefined);
  assert.strictEqual(r.rows[1].ttfbMs, undefined);
  assert.strictEqual(r.rows[1].downloadMs, 160);
  assert.strictEqual(r.joinMs, 200);
  assert.strictEqual(r.ladderKnown, false);
  assert.strictEqual(r.isTopRung, false);
}

// 4. first segment is the top rung (Peloton live: 1080p, 12 s, ~7.7 MB).
{
  const r = computeStartup(
    [
      rec('master', 0, 50, 60),
      rec('variant', 70, 80, 90, { bandwidthDeclared: 5000000, resolution: '1920x1080' }),
      rec('variant', 70, 80, 95, { bandwidthDeclared: 1000000, resolution: '640x360' }),
      rec('video-segment', 100, 300, 2000, { bandwidthDeclared: 5000000, resolution: '1920x1080', bytes: 7.7e6 }),
    ],
    0,
    2500
  );
  assert.strictEqual(r.isTopRung, true);
  assert.strictEqual(r.startedOnRung, '1920x1080');
  assert.strictEqual(r.firstSegmentBytes, 7.7e6);
  assert.strictEqual(r.firstFrameMs, 2500);
  const j: any = toJson(r);
  assert.strictEqual(j.joinMs, 2000);
  assert.strictEqual(j.startedOnTopRung, true);
}

// 5. no master yet
assert.strictEqual(computeStartup([rec('variant', 1)]).rows.length, 0);
console.log('startup-waterfall.logic: all tests passed');
