import * as assert from 'assert';
import { buildFeedbackMailto, stripQuery } from './feedback-mailto.logic';

assert.strictEqual(stripQuery('https://a.net/m.m3u8?hdnts=exp=1~hmac=abc#x'), 'https://a.net/m.m3u8');
assert.strictEqual(stripQuery(''), '');
assert.strictEqual(stripQuery(undefined as any), '');
const m = buildFeedbackMailto('1.2.3', 'https://a.net/m.m3u8?token=SECRET&b=2');
assert.ok(m.startsWith('mailto:raul@onepeloton.com?subject=MOE%20Viewer%20feedback&body='));
assert.ok(!/SECRET|token|%3Fb/i.test(m));
const body = decodeURIComponent(m.split('&body=')[1]);
assert.ok(body.includes('1.2.3') && body.includes('Manifest: https://a.net/m.m3u8'));
assert.ok(decodeURIComponent(buildFeedbackMailto('1', '').split('&body=')[1]).includes('Manifest: —'));
console.log('feedback-mailto: ok');
