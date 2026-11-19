import * as assert from 'assert';
import { redact, redactText } from './report-redact.logic';
import { buildReport, escapeHtml, renderReportHtml, ReportState } from './session-report.logic';

// fake tokens only
const TOKEN = 'exp=1893456000~acl=/classes/*~hmac=0123456789abcdef0123456789abcdef';
const BAD = /hdnts|hdntl|hdnea|hmac|0123456789abcdef/i;

// redact: query, path segments (including a multi-segment acl), CMCD sid
assert.ok(!BAD.test(redact(`https://a.net/v/master.m3u8?hdnts=${TOKEN}&rendition=sd`)));
assert.strictEqual(redact(`https://a.net/v/master.m3u8?hdnts=${TOKEN}&rendition=sd`), 'https://a.net/v/master.m3u8?rendition=sd');
const pathTok = redact(`https://a.net/hdntl=exp=1~acl=/classes/*~hmac=abcdef/v/master.m3u8?x=1#frag`);
assert.strictEqual(pathTok, 'https://a.net/{token}/v/master.m3u8?x=1');
assert.ok(!BAD.test(redact(`https://a.net/p/hdnts=exp=1~hmac=ff/m.m3u8`)));
const cmcd = redact('https://a.net/m.m3u8?CMCD=br%3D1000%2Csid%3D%22abc-123%22%2Cv%3D1');
assert.ok(!/abc-123/.test(cmcd) && /br%3D1000/.test(cmcd), cmcd);
assert.strictEqual(redact(''), '');
assert.ok(!/SECRET/.test(redact('https://a.net/m.m3u8?token=SECRET&a=1')));

// free text
assert.ok(!BAD.test(redactText(`GET https://a.net/m.m3u8?hdntl=${TOKEN} failed`)));
assert.ok(!BAD.test(redactText(`url https://a.net/hdntl=exp=1~acl=/c/*~hmac=0123456789abcdef/x.ts hmac=0123456789abcdef`)));
assert.ok(!/sess-9/.test(redactText('cmcd sid="sess-9" br=1')));

assert.strictEqual(escapeHtml(`<script>"x"&'y'</script>`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');

const base = (over: Partial<ReportState> = {}): ReportState => ({
  now: new Date('2026-01-02T03:04:05.000Z'),
  userAgent: 'UA <b>x</b>',
  manifestUrl: `https://a.net/classes/master.m3u8?hdnts=${TOKEN}&CMCD=sid%3D%22s1%22`,
  records: [
    { id: 1, url: `https://a.net/m.m3u8?hdnts=${TOKEN}`, kind: 'master', tRequest: 0, tFirstByte: 20, tLoaded: 30, status: 200, headers: { 'x-cache': 'TCP_HIT from a23-1-2-3' } },
    { id: 2, url: `https://a.net/hdntl=${TOKEN}/v1.m3u8`, kind: 'variant', level: 0, tRequest: 40, tLoaded: 60, status: 403, error: `fail hdntl=${TOKEN}` },
  ],
  declaredLevels: [
    { bandwidth: 800000, averageBandwidth: 700000, resolution: '640x360' },
    { bandwidth: 2000000, averageBandwidth: 1800000, resolution: '1280x720' },
  ],
  references: [],
  lintIssues: [{ severity: 'warning', code: 'X', message: `<img src=x onerror=1> ${TOKEN}` }],
  videoErrors: [`media error ?hdnts=${TOKEN}`],
  logs: Array.from({ length: 120 }, (_, i) => `[Hls.js log] line ${i} https://a.net/m.m3u8?hdnts=${TOKEN}`),
  singleBitrateKey: 'sd',
  audioTrack: 'English / en',
  ...over,
});

const report = buildReport(base());
assert.strictEqual(report.logTail.length, 50);
assert.ok(report.logTail[49].includes('line 119'));
assert.strictEqual(report.ladder.rungs.length, 2);
assert.strictEqual(report.singleBitrate, 'sd');
assert.strictEqual(report.generatedAt, '2026-01-02T03:04:05.000Z');
assert.strictEqual(report.errors.failedRequests.length, 1);

const json = JSON.stringify(report);
assert.ok(!BAD.test(json), 'json leaks a token');
assert.ok(!/"s1"|%22s1%22/.test(json));
const html = renderReportHtml(report);
assert.ok(!BAD.test(html), 'html leaks a token');
assert.ok(!html.includes('<img src=x') && !html.includes('UA <b>'), 'html not escaped');
assert.ok(html.includes('&lt;img src=x onerror=1&gt;'));
assert.ok(html.startsWith('<!doctype html>') && !/<script/i.test(html));

// empty session still renders
const empty = buildReport(base({ records: [], declaredLevels: [], logs: [], lintIssues: [], videoErrors: [] }));
assert.ok(renderReportHtml(empty).includes('Master ladder'));

console.log('session-report: ok');
