// tslint:disable:max-line-length
import * as assert from 'assert';
import {
  buildRow,
  classifyCache,
  detectSingleBitrate,
  edgeWorkerEntries,
  filterRows,
  headerVisibility,
  median,
  orderRows,
  parseServerTiming,
  parseXCache,
  sanitizeCacheKey,
  stripUrl,
  summarize,
} from './edge-view.logic';

const TOKEN = 'exp=1893456000~acl=/classes/*~hmac=deadbeefcafe0123456789';
const tokenised = `https://amd-vod.akamaized.net/classes/abc/hdntl=${TOKEN}/1/master.m3u8?hdntl=${TOKEN}&token=SECRETVALUE#frag`;

// stripUrl
const stripped = stripUrl(tokenised);
assert.strictEqual(stripped, 'amd-vod.akamaized.net/classes/abc/{token}/1/master.m3u8');
assert.ok(!/hmac|deadbeef|SECRET|hdntl=/.test(stripped), 'token must not survive');
assert.strictEqual(stripUrl('https://a.akamaized.net/x/seg_1.ts?hdnts=st=1~hmac=ff'), 'a.akamaized.net/x/seg_1.ts');
assert.strictEqual(stripUrl(''), '');

// cache key
assert.strictEqual(sanitizeCacheKey('/L/1234/5678/1d/amd-vod.akamaized.net/classes/m.m3u8?hdntl=exp=1~hmac=aa'), '/L/1234/5678/1d/amd-vod.akamaized.net/classes/m.m3u8');
assert.strictEqual(sanitizeCacheKey(`/L/1/2/1d/h/p/hdntl=${TOKEN}/m.m3u8`), '/L/1/2/1d/h/p/{token}/m.m3u8');

// server-timing
const st = parseServerTiming('cdn-cache; desc=HIT, edge; dur=12, origin; dur=140.5, ak_p; desc="x";dur=3');
assert.deepStrictEqual(st.map((e) => e.name), ['cdn-cache', 'edge', 'origin', 'ak_p']);
assert.strictEqual(st[0].desc, 'HIT');
assert.strictEqual(st[1].dur, 12);
assert.strictEqual(st[2].dur, 140.5);
assert.strictEqual(st[3].desc, 'x');
assert.deepStrictEqual(parseServerTiming(undefined), []);

// x-cache parsing
assert.deepStrictEqual(parseXCache('TCP_MEM_HIT from a23-1-2-3.deploy.akamaitechnology.com (AkamaiGHost/11.1) (-)'), {
  token: 'TCP_MEM_HIT',
  edge: 'a23-1-2-3.deploy.akamaitechnology.com',
});

// classification
const c = (h: Record<string, string>) => classifyCache(h);
assert.strictEqual(c({ 'x-cache': 'TCP_HIT from a1-2' }).result, 'hit');
assert.strictEqual(c({ 'x-cache': 'TCP_MEM_HIT from a1-2' }).result, 'hit');
assert.strictEqual(c({ 'x-cache': 'TCP_REFRESH_HIT from a1-2' }).result, 'hit');
assert.strictEqual(c({ 'x-cache': 'TCP_MISS from a1-2' }).result, 'miss');
assert.strictEqual(c({ 'x-cache': 'TCP_REFRESH_MISS from a1-2' }).result, 'miss');
assert.strictEqual(c({ 'akamai-cache-status': 'Hit from child' }).result, 'hit');
assert.strictEqual(c({ 'akamai-cache-status': 'Miss from child, Miss from parent' }).result, 'miss');
assert.strictEqual(c({ 'akamai-cache-status': 'Miss from child, Hit from parent' }).result, 'hit');
assert.strictEqual(c({ 'server-timing': 'cdn-cache; desc=HIT' }).result, 'hit');
assert.strictEqual(c({ 'server-timing': 'cdn-cache; desc=MISS' }).source, 'server-timing');
assert.strictEqual(c({ 'server-timing': 'edge; dur=1' }).result, 'unknown');
assert.strictEqual(c({}).result, 'unknown');
assert.strictEqual(c({ 'akamai-cache-status': 'Hit from child', 'x-cache': 'TCP_MISS from a' }).source, 'akamai-cache-status');

// edge worker headers
assert.deepStrictEqual(edgeWorkerEntries({ 'x-pton-ew': 'sbr', 'x-akamai-edgeworker-id': '9', server: 'AkamaiGHost' }), [
  'x-akamai-edgeworker-id: 9',
  'x-pton-ew: sbr',
]);

// rows + summary
const rec = (id: number, kind: string, headers: Record<string, string>, extra: object = {}) => ({
  id,
  kind,
  url: `https://amd-vod.akamaized.net/c/${id}.ts?token=SECRET`,
  status: 200,
  tRequest: 100 * id,
  tFirstByte: 100 * id + 20,
  tLoaded: 100 * id + 50,
  headers,
  ...extra,
});
const records = [
  rec(1, 'master', { 'x-pton-ew': 'sbr' }),
  rec(2, 'video-segment', { 'x-cache': 'TCP_HIT from a1', 'server-timing': 'edge; dur=10, origin; dur=0', 'content-length': '1000' }, { tFirstByte: 200 + 10 }),
  rec(3, 'video-segment', { 'x-cache': 'TCP_MISS from a2', 'server-timing': 'edge; dur=30, origin; dur=100' }, { tFirstByte: 300 + 90 }),
  rec(4, 'video-segment', { 'x-cache': 'TCP_MEM_HIT from a1' }, { tFirstByte: 400 + 30 }),
  rec(5, 'audio-segment', {}),
  rec(6, 'variant', {}),
];
const rows = records.map(buildRow);
assert.ok(rows.every((r) => !/SECRET|token=/.test(r.path)), 'row paths never carry the query');
assert.strictEqual(rows[1].ttfbMs, 10);
assert.strictEqual(rows[1].downloadMs, 40);
assert.strictEqual(rows[1].contentLength, 1000);
assert.strictEqual(rows[1].edgeDurMs, 10);
assert.strictEqual(rows[1].servedBy, 'a1');
assert.strictEqual(rows[0].hasEdgeWorker, true);
const sum = summarize(rows);
assert.strictEqual(sum.segments, 4);
assert.strictEqual(sum.classifiedSegments, 3);
assert.strictEqual(sum.hits, 2);
assert.ok(Math.abs((sum.hitRatio as number) - 2 / 3) < 1e-9);
assert.strictEqual(sum.medianTtfbHitMs, 20);
assert.strictEqual(sum.medianTtfbMissMs, 90);
assert.strictEqual(sum.medianEdgeDurMs, 20);
assert.strictEqual(sum.medianOriginDurMs, 50);
assert.strictEqual(sum.edgeWorkerSeen, true);
assert.strictEqual(summarize([]).hitRatio, undefined);
assert.strictEqual(median([3, 1, 2]), 2);
assert.strictEqual(median([]), undefined);

// ordering + filter: master then variant pinned, rest by id
assert.deepStrictEqual(orderRows(rows).map((r) => r.id), [1, 6, 2, 3, 4, 5]);
assert.deepStrictEqual(filterRows(rows, 'video-segment').map((r) => r.id), [2, 3, 4]);
assert.strictEqual(filterRows(rows, 'all').length, 6);

// single bitrate
const mk = (id: number, kind: string, url: string, level?: number, headers: Record<string, string> = {}) => ({ id, kind, url, level, tRequest: id, headers });
const seg = (id: number) => mk(id, 'video-segment', `https://h/s${id}.ts`, 0);
assert.strictEqual(
  detectSingleBitrate({ records: [mk(1, 'master', 'https://h/a/master_720p.m3u8'), mk(2, 'variant', 'https://h/a/v.m3u8', 0), seg(3), seg(4)] }).isSingle,
  true
);
assert.strictEqual(
  detectSingleBitrate({ records: [mk(1, 'master', 'https://h/a/master.m3u8', undefined, { 'x-pton-ew': 'sbr' }), seg(3), seg(4)], declaredVideoVariants: 1 }).isSingle,
  true
);
assert.strictEqual(detectSingleBitrate({ records: [mk(1, 'master', 'https://h/a/master.m3u8'), seg(3), seg(4)], declaredVideoVariants: 1 }).isSingle, false, 'no hint');
assert.strictEqual(detectSingleBitrate({ records: [mk(1, 'master', 'https://h/a/master_720p.m3u8')], declaredVideoVariants: 4 }).isSingle, false, 'full ladder');
assert.strictEqual(detectSingleBitrate({ records: [mk(1, 'master', 'https://h/master_720p.m3u8'), seg(2)] }).isSingle, false, 'too little evidence');
assert.strictEqual(detectSingleBitrate({ records: [] }).isSingle, false);

// header visibility
const vis = headerVisibility([{ headers: { age: '5', 'x-pton-ew': 'sbr', 'x-cache': 'TCP_HIT from a' } }]);
const seen = (n: string) => vis.find((v) => v.name === n)!.seen;
assert.strictEqual(seen('x-cache'), true);
assert.strictEqual(seen('age'), true);
assert.strictEqual(seen('x-pton-*'), true);
assert.strictEqual(seen('server-timing'), false);
assert.strictEqual(seen('x-cache-key'), false);
assert.strictEqual(seen('x-akamai-edgeworker-* / akamai-x-ew-*'), false);

console.log('edge-view.logic.spec: all assertions passed');
