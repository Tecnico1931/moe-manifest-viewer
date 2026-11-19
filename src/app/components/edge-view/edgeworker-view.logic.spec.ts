// tslint:disable:max-line-length
import * as assert from 'assert';
import { EwFinding, inferEdgeWorker, parseAttributes, parseMaster, parsePtonEw, queryParam } from './edgeworker-view.logic';

const ladder = (heights: number[]) =>
  heights.map((h, i) => `#EXT-X-STREAM-INF:BANDWIDTH=${(i + 1) * 1000000},AVERAGE-BANDWIDTH=900000,RESOLUTION=${Math.round((h * 16) / 9)}x${h},CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"\nv${h}/index.m3u8`).join('\n');
const subs = (names: string[]) => names.map((n) => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${n}",LANGUAGE="x",URI="s/${n}.m3u8"`).join('\n');
const audio = (names: string[], uris: Record<string, string> = {}) =>
  names.map((n) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${n}",DEFAULT=NO,URI="${uris[n] || `a/${n}.m3u8`}"`).join('\n');
const master = (parts: string[]) => `#EXTM3U\n${parts.join('\n')}\n`;
const get = (fs: EwFinding[], id: string): EwFinding => fs.find((x) => x.id === id) as EwFinding;
const rec = (u: string, headers?: Record<string, string>) => [{ kind: 'master', url: u, headers, tRequest: 1 }];
const TOKEN = 'hdnts=exp=1~acl=/x/*~hmac=SECRETHMAC';

// parsing helpers
assert.deepStrictEqual(parseAttributes('#EXT-X-MEDIA:TYPE=AUDIO,NAME="a, b",DEFAULT=YES'), { TYPE: 'AUDIO', NAME: 'a, b', DEFAULT: 'YES' });
assert.strictEqual(queryParam('https://h/m.m3u8?a=1&rendition=hd#x', 'rendition'), 'hd');
assert.strictEqual(queryParam('https://h/m.m3u8?a=1', 'rendition'), undefined);
assert.deepStrictEqual(parsePtonEw('ok;sr=1;h=1080'), { ok: true, sr: true, height: 1080 });
assert.strictEqual(parsePtonEw(undefined), undefined);
const parsed = parseMaster(master([ladder([1080, 720]), '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="i.m3u8"', audio(['A']), subs(['English'])]));
assert.strictEqual(parsed.variants.length, 2);
assert.strictEqual(parsed.iframeCount, 1);
assert.strictEqual(parsed.media.length, 2);

// single rendition: collapsed, matches rendition key (inferred)
let url = 'https://amd-vod.akamaized.net/classes/x/1/master.m3u8?rendition=hd';
let f = get(inferEdgeWorker({ masterText: master([ladder([1080])]), records: rec(url) }), 'single-rendition');
assert.strictEqual(f.state, 'yes');
assert.strictEqual(f.confidence, 'inferred');
assert.ok(/equals the target/.test(f.evidence), f.evidence);

// header makes it certain
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec(url, { 'x-pton-ew': 'ok;sr=1;h=720' }) }), 'single-rendition');
assert.strictEqual(f.confidence, 'certain');
assert.ok(/h=720/.test(f.evidence));

// default 720 for unknown key / no key
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec('https://h/m.m3u8?rendition=zz') }), 'single-rendition');
assert.ok(/unknown key, default 720p/.test(f.evidence));
f = get(inferEdgeWorker({ masterText: master([ladder([540])]), records: rec('https://h/m.m3u8?rendition=hd') }), 'single-rendition');
assert.ok(/differs from target 1080/.test(f.evidence));

// full ladder
f = get(inferEdgeWorker({ masterText: master([ladder([1080, 720, 540])]), records: rec(url) }), 'single-rendition');
assert.strictEqual(f.state, 'no');
assert.ok(/1080\/720\/540p/.test(f.evidence));

// no resolution / no variants -> unknown
f = get(inferEdgeWorker({ masterText: master(['#EXT-X-STREAM-INF:BANDWIDTH=1', 'a.m3u8']), records: rec(url) }), 'single-rendition');
assert.strictEqual(f.state, 'unknown');

// no master text -> unknowns, header findings still work
let all = inferEdgeWorker({ records: rec(url, { 'x-pton-ew': 'ok;sr=1;h=1080' }) });
assert.strictEqual(get(all, 'ran').state, 'yes');
assert.strictEqual(get(all, 'ran').confidence, 'certain');
assert.strictEqual(get(all, 'subtitles').state, 'unknown');
assert.strictEqual(all.length, 7);

// subtitles
url = 'https://h/m.m3u8?subtitle_name=English,Spanish';
f = get(inferEdgeWorker({ masterText: master([ladder([720]), subs(['English', 'Spanish'])]), records: rec(url) }), 'subtitles');
assert.strictEqual(f.state, 'yes');
f = get(inferEdgeWorker({ masterText: master([ladder([720]), subs(['English', 'Spanish', 'French', 'German'])]), records: rec(url) }), 'subtitles');
assert.strictEqual(f.state, 'no');
assert.ok(/French, German/.test(f.evidence));
f = get(inferEdgeWorker({ masterText: master([ladder([720]), subs(['English', 'Spanish'])]), records: rec('https://h/m.m3u8') }), 'subtitles');
assert.strictEqual(f.state, 'unknown');
assert.ok(/English, Spanish/.test(f.evidence));

// radio
const mixer = 'https://mcs.example/radio/api/v1/mixer/audio/playlist?radio_playlist=p&instructor_playlist=https://h/a.m3u8';
const radioAudio = audio(['Instructor Only', 'Mixed', 'Music Boosted', 'Instructor Boosted'], { Mixed: mixer, 'Music Boosted': mixer, 'Instructor Boosted': mixer });
f = get(inferEdgeWorker({ masterText: master([ladder([720]), radioAudio]), records: rec('https://h/m.m3u8?radio_enabled=true&radio_playlist=p') }), 'radio');
assert.strictEqual(f.state, 'yes');
assert.strictEqual(f.confidence, 'certain');
assert.ok(!/instructor_playlist|radio_playlist=p/.test(f.evidence), 'mixer query must not be echoed');
f = get(inferEdgeWorker({ masterText: master([ladder([720]), audio(['Instructor Only'])]), records: rec('https://h/m.m3u8?radio_enabled=1') }), 'radio');
assert.strictEqual(f.state, 'yes');
assert.strictEqual(f.confidence, 'inferred');
f = get(inferEdgeWorker({ masterText: master([ladder([720]), audio(['English', 'Spanish'])]), records: rec('https://h/m.m3u8?radio_enabled=1') }), 'radio');
assert.strictEqual(f.state, 'no');
f = get(inferEdgeWorker({ masterText: master([ladder([720]), audio(['English'])]), records: rec('https://h/m.m3u8') }), 'radio');
assert.strictEqual(f.state, 'no');

// reroute
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec('https://h/classes/x/1/master_720p.m3u8') }), 'reroute-720p');
assert.strictEqual(f.state, 'yes');
assert.strictEqual(f.confidence, 'inferred');
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec('https://h/master.m3u8', { 'x-pton-ew-bypass': '720' }) }), 'reroute-720p');
assert.strictEqual(f.confidence, 'certain');
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec('https://h/master.m3u8') }), 'reroute-720p');
assert.strictEqual(f.state, 'no');

// gate skip
all = inferEdgeWorker({ masterText: master([ladder([1080, 720])]), records: rec('https://h/master.m3u8', { 'x-pton-ew-bypass': 'skip' }) });
assert.strictEqual(get(all, 'ran').state, 'no');
assert.strictEqual(get(all, 'ran').confidence, 'certain');

// failover
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec('https://h/master.m3u8', { 'x-ew-failover': 'attempt-2' }) }), 'failover');
assert.strictEqual(f.state, 'yes');
assert.strictEqual(f.confidence, 'certain');
f = get(inferEdgeWorker({ masterText: master([ladder([1080, 720])]), records: rec('https://h/master.m3u8', { server: 'CloudFront' }) }), 'failover');
assert.strictEqual(f.state, 'yes');
assert.strictEqual(f.confidence, 'inferred');
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec('https://h/master.m3u8', { server: 'AkamaiGHost' }) }), 'failover');
assert.strictEqual(f.state, 'no');
f = get(inferEdgeWorker({ masterText: master([ladder([720])]), records: rec('https://h/master.m3u8') }), 'failover');
assert.strictEqual(f.state, 'unknown');

// token: never leaks the value, always unknown
const tokenised = `https://h/classes/x/master.m3u8?rendition=sd&${TOKEN}`;
all = inferEdgeWorker({ masterText: master([ladder([720])]), records: rec(tokenised) });
const dump = JSON.stringify(all);
assert.ok(!/SECRETHMAC|hmac=/.test(dump), 'token must not appear in findings');
assert.strictEqual(get(all, 'token').state, 'unknown');
assert.ok(/hdnts in the query/.test(get(all, 'token').evidence));

// robustness
assert.doesNotThrow(() => inferEdgeWorker({ records: [] }));
assert.doesNotThrow(() => inferEdgeWorker({ masterText: '', records: [] }));

console.log('edgeworker-view.logic.spec: ok');
