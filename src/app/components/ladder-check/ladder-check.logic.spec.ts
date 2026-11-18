import * as assert from 'assert';
import {
  bitsPerPixel,
  formatKbps,
  interpolateAtHeight,
  logTicks,
  parseMasterLadder,
  percentDiff,
  runChecks,
  RefRung,
  Rung,
  rungsFromLevels,
  stepRatios,
} from './ladder-check.logic';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// interpolation
const ref: RefRung[] = [
  [640, 360, 1000000],
  [1280, 720, 3000000],
  [1920, 1080, 6000000],
  [1920, 1080, 5000000],
];
near(interpolateAtHeight(ref, 360) as number, 1000000);
near(interpolateAtHeight(ref, 540) as number, 2000000);
near(interpolateAtHeight(ref, 1080) as number, 6000000); // duplicates: highest wins
assert.strictEqual(interpolateAtHeight(ref, 240), null);
assert.strictEqual(interpolateAtHeight(ref, 1440), null);
assert.strictEqual(interpolateAtHeight([], 360), null);

// bpp
near(bitsPerPixel(3000000, 1280, 720, 30), 3000000 / (1280 * 720 * 30));
near(bitsPerPixel(1000000, 640, 360), 1000000 / (640 * 360 * 30));
assert.ok(isNaN(bitsPerPixel(1, 0, 0)));

// percent diff
near(percentDiff(1500, 1000) as number, 50);
near(percentDiff(500, 1000) as number, -50);
assert.strictEqual(percentDiff(1, null), null);

// parsing
const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=29.970,CODECS="avc1.64001f,mp4a.40.2"
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
b.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,RESOLUTION=640x360,URI="i.m3u8"
`;
const rungs = parseMasterLadder(master);
assert.strictEqual(rungs.length, 2);
assert.deepStrictEqual(rungs[0], { width: 640, height: 360, peak: 1000000, avg: undefined, fps: undefined });
assert.strictEqual(rungs[1].avg, 2500000);
near(rungs[1].fps as number, 29.97);
assert.strictEqual(rungsFromLevels([{ bandwidth: 5 }, { resolution: '1x1' }]).length, 0);

// step ratios
const r = (height: number, peak: number, avg?: number): Rung => ({ width: (height * 16) / 9, height, peak, avg });
const steps = stepRatios([r(360, 1000), r(540, 1200), r(720, 3600)]);
assert.strictEqual(steps[0], null);
near(steps[1] as number, 1.2);
near(steps[2] as number, 3);

// checks
const kinds = (c: { kind: string }[]) => c.map((x) => x.kind).sort();
const checks = runChecks([r(360, 1000000, 900000), r(360, 1100000, 1000000), r(720, 4000000)], [{ name: 'A', ladder: ref }]);
assert.deepStrictEqual(kinds(checks), ['duplicate-height', 'missing-avg', 'step-large', 'step-small', 'top-above'].sort());
assert.deepStrictEqual(kinds(runChecks([r(360, 1000000, 1), r(720, 2000000, 1)], [{ name: 'A', ladder: ref }])), ['top-below']);
assert.deepStrictEqual(kinds(runChecks([r(360, 1000000, 1), r(720, 2000000, 1)], [])), []);
const noReach: RefRung[] = [[1, 1080, 1]];
assert.deepStrictEqual(kinds(runChecks([r(360, 1000000, 1), r(720, 2000000, 1)], [{ name: 'B', ladder: noReach }])), []);
// exactly on thresholds: no flag
assert.deepStrictEqual(kinds(runChecks([r(360, 1000, 1), r(540, 1300, 1), r(720, 3250, 1)], [])), []);

// ticks and formatting
assert.deepStrictEqual(logTicks(300000, 4000000), [200000, 500000, 1000000, 2000000, 5000000]);
assert.strictEqual(formatKbps(500000), '500k');
assert.strictEqual(formatKbps(2500000), '2.5M');
console.log('ladder-check.logic: all tests passed');
