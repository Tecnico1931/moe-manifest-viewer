import * as assert from 'assert';
import {
  analyseCues,
  audioCodecsForGroup,
  checkCaptionMedia,
  cueIssues,
  formatSec,
  mapOffsetSec,
  parseMasterMedia,
  parseVtt,
  parseVttTime,
} from './caption-check.logic';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,CHANNELS="2",URI="a/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="s/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English 2",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="s/en2.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Nolang",URI="s/x.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Fr forced",LANGUAGE="fr",FORCED=YES,URI="s/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
v1.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000,CODECS="avc1.64001f,ec-3",AUDIO="aud",SUBTITLES="gone"
v2.m3u8
`;

const m = parseMasterMedia(MASTER, 'https://x.test/p/master.m3u8');
assert.strictEqual(m.media.length, 5);
assert.strictEqual(m.media[1].uri, 'https://x.test/p/s/en.m3u8');
assert.strictEqual(m.media[0].channels, '2');
assert.strictEqual(m.variants.length, 2);
assert.deepStrictEqual(audioCodecsForGroup(m.variants, 'aud'), ['mp4a.40.2', 'ec-3']);

const messages = checkCaptionMedia(m).map((i) => i.message);
const has = (s: string): boolean => messages.some((x) => x.indexOf(s) >= 0);
assert.ok(has('"Nolang" has no LANGUAGE'));
assert.ok(has('language "en" appears 2 times'));
assert.ok(has('DEFAULT=YES on 2 renditions'));
assert.ok(has('FORCED "Fr forced"'));
assert.ok(has('SUBTITLES="gone"'));
assert.ok(!has('AUDIO="aud"'));
assert.strictEqual(checkCaptionMedia(parseMasterMedia('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', 'https://x.test/')).length, 0);

assert.strictEqual(parseVttTime('01:02:03.500'), 3723.5);
assert.strictEqual(parseVttTime('02:03.500'), 123.5);
assert.ok(isNaN(parseVttTime('nope')));

const VTT = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000

NOTE hello

1
00:00:01.000 --> 00:00:03.000 align:start
Hello <b>world</b>

00:00:02.500 --> 00:00:04.000
Overlaps

00:00:30.000 --> 00:00:29.000
Backwards

00:00:31.000 --> 00:00:40.000


00:00:41.000 --> 00:00:42.000
This line is definitely longer than forty-two characters total
`;
const v = parseVtt(VTT);
assert.ok(v.isWebVtt);
assert.deepStrictEqual(v.timestampMap, { mpegts: 900000, local: 0 });
assert.strictEqual(mapOffsetSec(v.timestampMap), 10);
assert.strictEqual(v.cues.length, 5);
assert.strictEqual(v.cues[0].lines[0], 'Hello world');
const r = analyseCues([...v.cues, v.cues[0]]);
assert.strictEqual(r.total, 5);
assert.strictEqual(r.overlaps, 1);
assert.strictEqual(r.badTiming, 1);
assert.strictEqual(r.empty, 1);
assert.strictEqual(r.tooLong, 1);
assert.strictEqual(r.longLines, 1);
assert.strictEqual(r.gaps.length, 1);
assert.strictEqual(r.gaps[0].from, 4);
assert.strictEqual(r.firstStart, 1);
assert.strictEqual(r.lastEnd, 42);

const issues = cueIssues(r, { present: 1, total: 2, offsetsSec: [10, 0] }, 30, false).map((i) => i.message);
assert.ok(issues.some((x) => x.indexOf('Gap of') === 0));
assert.ok(issues.some((x) => x.indexOf('1 of 2 segments') > 0));
assert.ok(issues.some((x) => x.indexOf('offset differs') > 0));
assert.ok(issues.some((x) => x.indexOf('after the stream duration') > 0));
assert.ok(!cueIssues(r, { present: 2, total: 2, offsetsSec: [10] }, 30, true).some((i) => i.message.indexOf('after the stream') >= 0));
assert.strictEqual(cueIssues(analyseCues([]), { present: 0, total: 0, offsetsSec: [] }, 10, false)[0].severity, 'warn');
assert.ok(!parseVtt('<xml/>').isWebVtt);
assert.strictEqual(formatSec(65.04), '1:05.0');
console.log('caption-check.logic.spec OK');
