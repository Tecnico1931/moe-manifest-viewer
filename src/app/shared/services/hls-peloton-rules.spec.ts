import * as assert from 'assert';
import { runPelotonRules, checkCodecString, checkCrossVariantDurations, PELOTON_ISSUE_CODES as C } from './hls-peloton-rules';

const codes = (m: string, media = false) => runPelotonRules(m, media).map((i) => i.code);
const master = (v: string[]) => ['#EXTM3U', ...v].join('\n');

// Codec strings
assert.strictEqual(checkCodecString('avc1.4d401e'), null);
assert.strictEqual(checkCodecString('avc1.77.30')!.fix, 'avc1.4d001e');
assert.strictEqual(checkCodecString('avc1.66.30')!.fix, 'avc1.42001e');
assert.strictEqual(checkCodecString('avc1.100.40')!.fix, 'avc1.640028');
assert.strictEqual(checkCodecString('avc1.4d40')!.code, C.CODEC_MALFORMED);
assert.strictEqual(checkCodecString('mp4a.40.2'), null);
assert.strictEqual(checkCodecString('mp4a.40.29'), null);
assert.strictEqual(checkCodecString('mp4a.40.02')!.code, C.CODEC_MALFORMED);
assert.strictEqual(checkCodecString('mp4a.40.7')!.code, C.CODEC_MALFORMED);
assert.strictEqual(checkCodecString('hvc1.1.6.L93.B0'), null);
assert.strictEqual(checkCodecString('hvc1.main')!.code, C.CODEC_MALFORMED);

// Master: bandwidth rules
const good = master([
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"', 'a.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"', 'b.m3u8',
]);
assert.deepStrictEqual(codes(good), []);

const equal = master([
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=640x360', 'a.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=1280x720', 'b.m3u8',
]);
assert.deepStrictEqual(codes(equal), [C.AVG_BANDWIDTH_ALL_EQUAL]);

const missingAndOver = master([
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360', 'a.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=3500000,RESOLUTION=1280x720', 'b.m3u8',
]);
const mo = runPelotonRules(missingAndOver, false);
assert.deepStrictEqual(mo.map((i) => [i.code, i.severity, i.lineNumber]), [
  [C.AVG_BANDWIDTH_MISSING, 'warning', 2],
  [C.AVG_BANDWIDTH_EXCEEDS_PEAK, 'error', 4],
]);

const ratio = master([
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=900000,RESOLUTION=640x360', 'a.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=1280x720', 'b.m3u8',
]);
const r = runPelotonRules(ratio, false);
assert.deepStrictEqual(r.map((i) => i.code), [C.PEAK_AVG_RATIO]);
assert.ok(r[0].details!.includes('1.11') === false && r[0].details!.includes('3.00'));

// Ladder
const ladder = master([
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"', 'a.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1050000,AVERAGE-BANDWIDTH=850000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"', 'b.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2400000,CODECS="avc1.4d401f,mp4a.40.2"', 'c.m3u8',
]);
assert.deepStrictEqual(codes(ladder).sort(), [C.LADDER_NEAR_DUPLICATE, C.VIDEO_RESOLUTION_MISSING].sort());

// CMCD in variant URI
const cmcd = master([
  '#EXT-X-STREAM-INF:BANDWIDTH=450000,AVERAGE-BANDWIDTH=400000,RESOLUTION=640x360', 'a.m3u8?CMCD=br%3D24%2Csid%3D%22x%22',
]);
assert.deepStrictEqual(codes(cmcd), [C.CMCD_BR_TOO_LOW]);

// Media: drift, last exempt, live long segments
const media = ['#EXTM3U', '#EXT-X-TARGETDURATION:12', '#EXT-X-MEDIA-SEQUENCE:5',
  '#EXTINF:12.0,', 's1.ts', '#EXTINF:8.0,', 's2.ts', '#EXTINF:12.0,', 's3.ts', '#EXTINF:3.0,', 's4.ts'].join('\n');
const m = runPelotonRules(media, true);
assert.deepStrictEqual(m.map((i) => i.code).sort(), [C.LIVE_LONG_SEGMENTS, C.SEGMENT_DURATION_DRIFT].sort());
assert.strictEqual(m.find((i) => i.code === C.SEGMENT_DURATION_DRIFT)!.lineNumber, 6);
assert.ok(!media.includes('line 11')); // last segment (line 10) not reported
assert.ok(!m.find((i) => i.code === C.SEGMENT_DURATION_DRIFT)!.details!.includes('line 10'));
assert.deepStrictEqual(codes(media + '\n#EXT-X-ENDLIST', true), [C.SEGMENT_DURATION_DRIFT]);
assert.deepStrictEqual(codes(media.replace('#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-PART-INF:PART-TARGET=1.0'), true), [C.SEGMENT_DURATION_DRIFT]);

// Cross variant
const p = (d: string) => `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\na.ts\n#EXTINF:${d},\nb.ts`;
assert.strictEqual(checkCrossVariantDurations([{ name: 'v1', text: p('6.0') }, { name: 'v2', text: p('6.0') }]).length, 0);
assert.strictEqual(checkCrossVariantDurations([{ name: 'v1', text: p('6.0') }, { name: 'v2', text: p('5.5') }]).length, 1);

console.log('hls-peloton-rules: all assertions passed');
