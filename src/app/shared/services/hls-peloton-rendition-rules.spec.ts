import * as assert from 'assert';
import { runPelotonRules, PELOTON_ISSUE_CODES as C } from './hls-peloton-rules';
import { parseRenditionName } from './hls-peloton-rendition-rules';

const master = (v: string[]) => ['#EXTM3U', ...v].join('\n');
const sv = (bw: number, res: string | null, uri: string) =>
  [`#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${Math.round(bw * 0.7)}${res ? `,RESOLUTION=${res}` : ''},CODECS="avc1.4d401f,mp4a.40.2"`, uri];
const rend = (m: string) => runPelotonRules(m, false).filter((i) => /^PL06/.test(i.code));
const codes = (m: string) => rend(m).map((i) => i.code);

assert.strictEqual(parseRenditionName('https://x.example/c/master_4800k.m3u8?a=b').modifier, '4800k');
assert.strictEqual(parseRenditionName('master.m3u8').kind, 'none');
assert.strictEqual(parseRenditionName('master_900p.m3u8').kind, 'height');

// vod-v2 style ladder: clean
const v2 = master([
  ...sv(3849092, '1920x1080', 'tok/master_4800k.m3u8'),
  ...sv(1546688, '1280x720', 'tok/master_3000k.m3u8'),
  ...sv(903295, '960x540', 'tok/master_1800k.m3u8'),
  ...sv(550729, '640x360', 'tok/master_1000k.m3u8'),
  ...sv(486557, '512x288', 'tok/master_600k.m3u8'),
]);
assert.deepStrictEqual(codes(v2), []);

// missing modifier, unrecognised modifier, bitrate above cap, height mismatch
const bad = master([
  ...sv(3000000, '1920x1080', 'https://x.example/c/master.m3u8'),
  ...sv(1500000, '1280x720', 'master_3000x.m3u8'),
  ...sv(9000000, '960x540', 'master_1800k.m3u8'),
  ...sv(1700000, '1600x900', 'master_720p.m3u8'),
]);
const b = rend(bad);
assert.deepStrictEqual(b.map((i) => [i.code, i.severity]), [
  [C.RENDITION_NAME_MISSING, 'warning'],
  [C.RENDITION_NAME_UNRECOGNISED, 'warning'],
  [C.RENDITION_NAME_BITRATE_MISMATCH, 'warning'],
  [C.RENDITION_NAME_HEIGHT_MISMATCH, 'warning'],
]);
assert.strictEqual(b[0].lineNumber, 2);
assert.ok(b[0].details!.indexOf('master.m3u8') >= 0);

// far-below label is info
const low = master([...sv(3849092, '1920x1080', 'master_4800k.m3u8'), ...sv(300000, '1280x720', 'master_3000k.m3u8')]);
assert.deepStrictEqual(rend(low).map((i) => [i.code, i.severity]), [[C.RENDITION_NAME_BITRATE_MISMATCH, 'info']]);

// missing RESOLUTION, no 720p, duplicate heights
const noRes = master([...sv(3849092, null, 'master_4800k.m3u8'), ...sv(1546688, '1280x720', 'master_3000k.m3u8')]);
assert.deepStrictEqual(codes(noRes), [C.RENDITION_RESOLUTION_MISSING]);
const no720 = master([...sv(3849092, '1920x1080', 'master_4800k.m3u8'), ...sv(903295, '960x540', 'master_1800k.m3u8')]);
assert.deepStrictEqual(codes(no720), [C.RENDITION_NO_720P]);
const dup = master([...sv(1546688, '1280x720', 'master_3000k.m3u8'), ...sv(1400000, '1280x720', 'master_1800k.m3u8')]);
const d = rend(dup);
assert.ok(d.some((i) => i.code === C.RENDITION_DUPLICATE_HEIGHT && i.severity === 'info'));

// legacy 6000k/8000k ladders: info only
const legacy = master([...sv(7000000, '1920x1080', 'master_8000k.m3u8'), ...sv(5000000, '1920x1080', 'master_6000k.m3u8'), ...sv(1546688, '1280x720', 'master_3000k.m3u8')]);
const l = rend(legacy);
assert.ok(l.some((i) => i.code === C.RENDITION_LEGACY_LADDER && i.severity === 'info'));
assert.ok(l.every((i) => i.severity === 'info'));

// non-Peloton naming stays quiet
assert.deepStrictEqual(codes(master([...sv(1000000, '640x360', 'a.m3u8'), ...sv(3000000, '1280x720', 'b.m3u8')])), []);
// audio-only variant (no video codec) is ignored
assert.deepStrictEqual(codes(master([...v2.split('\n').slice(1), '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"', 'master_Mixed.m3u8'])), []);

console.log('hls-peloton-rendition-rules.spec OK');
