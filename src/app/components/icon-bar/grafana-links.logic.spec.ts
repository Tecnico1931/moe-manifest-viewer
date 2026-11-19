import * as assert from 'assert';
import { grafanaLinks, extractAssetId, isPelotonAkamaiUrl, buildExploreSql } from './grafana-links.logic';

const vod = 'https://amd-vod.akamaized.net/classes/cycling/2026-01-05/abc123def456/1/master.m3u8?hdnts=exp=1~hmac=SECRET';
assert.ok(isPelotonAkamaiUrl(vod));
assert.ok(isPelotonAkamaiUrl('https://qa1-amd.akamaized.net/classes/x/y/z/master.m3u8'));
assert.ok(!isPelotonAkamaiUrl('https://example.com/classes/x/y/z/a.m3u8'));
assert.ok(!isPelotonAkamaiUrl('not a url'));

assert.deepStrictEqual(extractAssetId(vod), { id: 'abc123def456', isClassId: true });
assert.deepStrictEqual(extractAssetId('https://amd-vod.akamaized.net/live/chan1/master.m3u8'), { id: 'live/chan1', isClassId: false });
assert.strictEqual(extractAssetId('https://amd-vod.akamaized.net/master.m3u8'), null);

const links = grafanaLinks(vod);
assert.strictEqual(links.length, 4);
assert.strictEqual(links[0].label, 'Class Analysis');
const u = new URL(links[0].url);
assert.strictEqual(u.pathname, '/d/cmcd_by_class');
assert.strictEqual(u.searchParams.get('var-reqHost'), 'amd-vod.akamaized.net');
assert.strictEqual(u.searchParams.get('var-pathLike'), '%abc123def456%');
assert.strictEqual(u.searchParams.get('from'), 'now-24h');
links.forEach((l) => assert.ok(l.url.indexOf('SECRET') === -1 && l.url.indexOf('hdnts') === -1 && l.url.indexOf('hmac') === -1));

const ex = new URL(links[3].url);
assert.strictEqual(ex.pathname, '/explore');
const left = JSON.parse(ex.searchParams.get('left') || '{}');
assert.strictEqual(left.queries[0].datasource.uid, 'cffmbn4dg0lc0d');
assert.ok(left.queries[0].rawSql.indexOf('reqPath LIKE \'%abc123def456%\'') !== -1);
assert.strictEqual(left.range.from, 'now-6h');

// unsafe characters never reach SQL
assert.strictEqual(extractAssetId('https://amd-vod.akamaized.net/classes/a/b/x\'%20OR%201=1/m.m3u8'), null);
assert.deepStrictEqual(grafanaLinks('https://example.com/a.m3u8'), []);
assert.ok(buildExploreSql('x').indexOf('akamai.logs') !== -1);
console.log('grafana-links.logic.spec OK');
