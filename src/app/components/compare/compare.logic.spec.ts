import * as assert from 'assert';
import { alignByHeight, audioSummary, deliveredKbps, firstSegments, measuredKbps, parseMaster, resolveUri, totals } from './compare.logic';

const A = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",CHANNELS="2",URI="a.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=30,AUDIO="aud"
v360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
v1080.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080,URI="iframe.m3u8"
`;
const B = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=600000,RESOLUTION=640x360
b360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
b720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1920x1080
b1080.m3u8
`;

const a = parseMaster(A);
const b = parseMaster(B);
assert.strictEqual(a.rungs.length, 2, 'i-frame ignored');
assert.strictEqual(a.rungs[0].codecs, 'avc1.4d401e,mp4a.40.2');
assert.strictEqual(a.rungs[0].fps, 30);
assert.strictEqual(a.rungs[1].uri, 'v1080.m3u8');
assert.strictEqual(audioSummary(a.audio), 'aud: English (2ch)');
assert.strictEqual(audioSummary(b.audio), 'none (muxed or not declared)');

const rows = alignByHeight(a.rungs, b.rungs);
assert.deepStrictEqual(rows.map((r) => r.height), [360, 720, 1080]);
assert.ok(Math.abs((rows[0].deltaBandwidthPct as number) - -10) < 1e-9);
assert.ok(Math.abs((rows[0].deltaAvgPct as number) - -25) < 1e-9);
assert.strictEqual(rows[1].a, undefined, 'B-only rung');
assert.strictEqual(rows[1].deltaBandwidthPct, undefined);
assert.ok(Math.abs((rows[2].deltaAvgPct as number) - -20) < 1e-9);

// same height twice pairs in bitrate order
const dup = alignByHeight(
  [{ width: 1, height: 720, bandwidth: 3 }, { width: 1, height: 720, bandwidth: 1 }],
  [{ width: 1, height: 720, bandwidth: 2 }]
);
assert.strictEqual(dup.length, 2);
assert.strictEqual(dup[0].deltaBandwidthPct, 100);
assert.strictEqual(dup[1].b, undefined);

const ta = totals(a.rungs);
assert.deepStrictEqual(ta, { count: 2, sumAvg: 3800000, sumBandwidth: 5000000, missingAvg: 0 });
assert.strictEqual(totals(b.rungs).missingAvg, 1);

assert.strictEqual(
  deliveredKbps(a.rungs[0], [{ resolution: '640x360', bandwidthKbps: 1000, avgKbps: 700, combinedAvgKbps: 760 }]),
  760
);
assert.strictEqual(deliveredKbps(a.rungs[0], [{ resolution: '640x360', bandwidthKbps: 999.5, avgKbps: 700 }]), 700);
assert.strictEqual(deliveredKbps(a.rungs[0], [{ resolution: '1280x720', bandwidthKbps: 1000, avgKbps: 700 }]), undefined);
assert.strictEqual(deliveredKbps(undefined, []), undefined);

assert.strictEqual(resolveUri('v.m3u8', 'https://h/p/master.m3u8?x=1'), 'https://h/p/v.m3u8?x=1');
assert.strictEqual(resolveUri('v.m3u8?y=2', 'https://h/p/master.m3u8?x=1'), 'https://h/p/v.m3u8?y=2');
assert.strictEqual(resolveUri('https://o/v.m3u8', 'https://h/p/master.m3u8?x=1'), 'https://o/v.m3u8');

const media = '#EXTM3U\n#EXTINF:6.0,\ns0.ts\n#EXTINF:6.0,\ns1.ts\n#EXTINF:4.0,\ns2.ts\n#EXTINF:6.0,\ns3.ts\n';
const segs = firstSegments(media, 'https://h/p/v.m3u8', 3);
assert.strictEqual(segs.length, 3);
assert.strictEqual(segs[2].url, 'https://h/p/s2.ts');
assert.strictEqual(measuredKbps([750000, 750000, 500000], segs.map((s) => s.duration)), 1000);
assert.strictEqual(measuredKbps([1], [0]), undefined);

console.log('compare.logic.spec: ok');
