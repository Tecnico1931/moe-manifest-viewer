import * as assert from 'assert';
import { redactTokens, hasToken, parseToken, isTokenExpired, describeRemaining } from './token-safety.logic';

const H = 'https://amd-vod.akamaized.net/classes/a/1/master.m3u8';
const TOK = 'exp=1700000000~acl=/classes/a/*~hmac=abcdef0123';

// query params
assert.strictEqual(redactTokens(`${H}?hdnts=${TOK}`), H);
assert.strictEqual(redactTokens(`${H}?hdntl=${TOK}`), H);
assert.strictEqual(redactTokens(`${H}?hdnts=${TOK}&b=2`), `${H}?b=2`);
assert.strictEqual(redactTokens(`${H}?a=1&hdnts=${TOK}&b=2`), `${H}?a=1&b=2`);
assert.strictEqual(redactTokens(`${H}?a=1&hdnts=${TOK}`), `${H}?a=1`);
assert.strictEqual(redactTokens(`${H}?hdnts=${TOK}#frag`), `${H}#frag`);
// mixed
assert.strictEqual(redactTokens(`${H}?hdnts=${TOK}&hdntl=${TOK}&x=y`), `${H}?x=y`);
assert.strictEqual(redactTokens(`${H}?hdnts=st=1~${TOK}`), H);
// path-embedded, acl containing slashes and escaped slashes
assert.strictEqual(
  redactTokens('https://qa1-amd.akamaized.net/hdntl=exp=1700000000~acl=/c/*~hmac=ab12/v/720p.m3u8'),
  'https://qa1-amd.akamaized.net/v/720p.m3u8'
);
assert.strictEqual(
  redactTokens('https://qa1-amd.akamaized.net/hdntl=exp=1700000000~acl=%2fc%2f*~hmac=ab12/v/720p.m3u8?x=1'),
  'https://qa1-amd.akamaized.net/v/720p.m3u8?x=1'
);
// encoded values (permalink, URI-encoded copy)
assert.strictEqual(redactTokens(encodeURIComponent(`${H}?hdnts=${TOK}`)), encodeURIComponent(H));
assert.strictEqual(redactTokens(encodeURIComponent(`${H}?a=1&hdnts=${TOK}&b=2`)), encodeURIComponent(`${H}?a=1&b=2`));
assert.strictEqual(redactTokens(`https://v.example/#url=${encodeURIComponent(`${H}?hdnts=${TOK}`)}&showVideo=1`), `https://v.example/#url=${encodeURIComponent(H)}&showVideo=1`);
assert.strictEqual(
  redactTokens(encodeURIComponent('https://q.net/hdntl=exp=1~acl=/c/*~hmac=ab12/v.m3u8')),
  encodeURIComponent('https://q.net/v.m3u8')
);
assert.ok(!/hmac|abcdef0123/.test(redactTokens(`x?hdnts=${encodeURIComponent(TOK)}&y=1`)));
// untouched
assert.strictEqual(redactTokens(`${H}?b=2`), `${H}?b=2`);
assert.strictEqual(redactTokens('https://a.net/hdntlike/x'), 'https://a.net/hdntlike/x');
assert.strictEqual(redactTokens(''), '');
assert.ok(hasToken(`${H}?hdnts=${TOK}`) && !hasToken(H));

// parse
const p = parseToken(`${H}?hdntl=st=1699990000~${TOK}`)!;
assert.deepStrictEqual(p, { name: 'hdntl', exp: 1700000000, st: 1699990000, acl: '/classes/a/*' });
assert.ok(!JSON.stringify(p).includes('hmac'));
assert.strictEqual(parseToken(`https://q.net/hdntl=${TOK}/v.m3u8`)!.acl, '/classes/a/*');
assert.strictEqual(parseToken(`${H}?hdnts=${encodeURIComponent(TOK)}`)!.exp, 1700000000);
assert.strictEqual(parseToken(H), null);

// expiry
assert.strictEqual(isTokenExpired(`${H}?hdnts=${TOK}`, 1700000001000), true);
assert.strictEqual(isTokenExpired(`${H}?hdnts=${TOK}`, 1699999000000), false);
assert.strictEqual(isTokenExpired(H, 1), false);
const now = 1700000000000;
assert.deepStrictEqual(describeRemaining(1700000000 + 720, now), { text: 'expires in 12m', state: 'ok' });
assert.deepStrictEqual(describeRemaining(1700000000 + 90, now), { text: 'expires in 1m', state: 'warn' });
assert.deepStrictEqual(describeRemaining(1700000000 + 30, now), { text: 'expires in 30s', state: 'warn' });
assert.deepStrictEqual(describeRemaining(1700000000 - 5, now), { text: 'expired', state: 'expired' });
console.log('token-safety: ok');
