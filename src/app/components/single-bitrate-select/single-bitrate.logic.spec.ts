import * as assert from 'assert';
import { readRendition, withRendition } from './single-bitrate.logic';

const tok = 'https://amd-vod.akamaized.net/a/master.m3u8?hdnts=exp=1~acl=/a/*~hmac=ab%2Fc';
const cases: [string, string, string][] = [
  ['https://h/m.m3u8', 'hd', 'https://h/m.m3u8?rendition=hd'],
  [tok, 'sd', tok + '&rendition=sd'],
  [tok + '&rendition=hd', 'lb', tok + '&rendition=lb'],
  [tok + '&rendition=hd', '', tok],
  ['https://h/m.m3u8?rendition=hd&x=1', '', 'https://h/m.m3u8?x=1'],
  ['https://h/m.m3u8?rendition=hd', '', 'https://h/m.m3u8'],
  ['https://h/m.m3u8?a=1&rendition=sd&b=2', 'hd', 'https://h/m.m3u8?a=1&b=2&rendition=hd'],
  ['https://h/m.m3u8?x=1#frag', 'hd', 'https://h/m.m3u8?x=1&rendition=hd#frag'],
];
for (const [url, key, want] of cases) {
  assert.strictEqual(withRendition(url, key), want, `withRendition(${url}, ${key})`);
}
assert.strictEqual(readRendition(tok + '&rendition=HD'), 'hd');
assert.strictEqual(readRendition(tok), '');
assert.strictEqual(readRendition(''), '');
console.log('single-bitrate.logic: all', cases.length + 3, 'checks pass');
