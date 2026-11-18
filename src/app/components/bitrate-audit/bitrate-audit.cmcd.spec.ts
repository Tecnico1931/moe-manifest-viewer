import * as assert from 'assert';
import { buildAudit, cmcdBrFromUrl } from './bitrate-audit.logic';

assert.strictEqual(cmcdBrFromUrl('https://h/a/seg1.ts?CMCD=br%3D24%2Cd%3D6006%2Cot%3Dv'), 24);
assert.strictEqual(cmcdBrFromUrl('https://h/a/seg1.ts?x=1&CMCD=bl%3D2000%2Cbr%3D3200'), 3200);
assert.strictEqual(cmcdBrFromUrl('https://h/a/seg1.ts'), undefined);
assert.strictEqual(cmcdBrFromUrl('https://h/a/seg1.ts?CMCD=d%3D6006'), undefined);

const seg = (i: number, br: number) => ({
  url: `https://h/a/360p/seg${i}.ts?CMCD=br%3D${br}%2Cd%3D6006`, kind: 'video-segment', level: 1,
  bandwidthDeclared: 551000, durationSec: 6, bytes: 340000,
});
const bad = buildAudit([seg(1, 24), seg(2, 22), seg(3, 30)]).video[0];
assert.strictEqual(bad.cmcdBrKbps, 24);
assert.strictEqual(bad.flagCmcdBr, true);
const good = buildAudit([seg(1, 424), seg(2, 424), seg(3, 424)]).video[0];
assert.strictEqual(good.flagCmcdBr, false);
const none = buildAudit([{ ...seg(1, 0), url: 'https://h/a/s.ts' }]).video[0];
assert.strictEqual(none.cmcdBrKbps, undefined);
assert.strictEqual(none.flagCmcdBr, false);
console.log('bitrate-audit CMCD spec: ok');
