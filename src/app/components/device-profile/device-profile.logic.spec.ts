import * as assert from 'assert';
import { DEVICE_PROFILES } from '../../shared/models/device-profiles';
import {
  capLevelIndex,
  describeProfile,
  getDeviceProfile,
  hlsConfigOverrides,
  isNoopProfile,
  resolveDeviceProfile,
  startLevelIndex,
  throttleDelayMs,
} from './device-profile.logic';

const ladder = [
  { height: 360, bitrate: 800e3 },
  { height: 540, bitrate: 1.6e6 },
  { height: 720, bitrate: 3e6 },
  { height: 1080, bitrate: 6e6 },
  { height: 2160, bitrate: 14e6 },
];

// lookup
assert.strictEqual(getDeviceProfile('bike-gen1')!.bandwidthMbps, 12);
assert.strictEqual(getDeviceProfile('nope'), undefined);
assert.strictEqual(resolveDeviceProfile('nope').id, 'default');
assert.strictEqual(resolveDeviceProfile(null).id, 'default');
assert.strictEqual(resolveDeviceProfile('phone').maxHeight, 720);
assert.strictEqual(new Set(DEVICE_PROFILES.map((p) => p.id)).size, DEVICE_PROFILES.length);
assert.ok(isNoopProfile(resolveDeviceProfile('default')));
assert.ok(!isNoopProfile(resolveDeviceProfile('tread')));

// delay maths: 2.5 MB at 20 Mbps = 1000 ms transfer; 40 ms latency; 100 ms already elapsed
assert.strictEqual(throttleDelayMs(2.5e6, 100, 20, 40), 940);
// response slower than the cap already: no delay, never negative
assert.strictEqual(throttleDelayMs(2.5e6, 5000, 20, 40), 0);
// no cap: latency only
assert.strictEqual(throttleDelayMs(1e6, 10, null, 50), 40);
// measured total (elapsed + delay) equals bytes*8/cap + latency
const bytes = 1.5e6;
const total = 30 + throttleDelayMs(bytes, 30, 12, 40);
assert.ok(Math.abs(total - (40 + (bytes * 8) / 12000)) < 1e-9);

// level filtering
assert.strictEqual(capLevelIndex(ladder, 1080), 3);
assert.strictEqual(capLevelIndex(ladder, 720), 2);
assert.strictEqual(capLevelIndex(ladder, null), 4);
assert.strictEqual(capLevelIndex(ladder, 200), 0);
assert.strictEqual(capLevelIndex([], 720), -1);
assert.strictEqual(startLevelIndex(ladder, resolveDeviceProfile('tread')), 3);
assert.strictEqual(startLevelIndex(ladder, resolveDeviceProfile('phone')), -1);
assert.strictEqual(startLevelIndex(ladder, resolveDeviceProfile('default')), -1);
// unsorted ladder: top = best bitrate among allowed
assert.strictEqual(startLevelIndex([ladder[3], ladder[4], ladder[0]], resolveDeviceProfile('tread')), 0);

// hls config
assert.deepStrictEqual(hlsConfigOverrides(resolveDeviceProfile('default')), {});
assert.strictEqual(hlsConfigOverrides(resolveDeviceProfile('slow-wifi')).abrEwmaDefaultEstimate, 3e6);
assert.strictEqual(hlsConfigOverrides(resolveDeviceProfile('slow-wifi')).capLevelToPlayerSize, false);
assert.ok(describeProfile(resolveDeviceProfile('phone')).includes('720p'));

console.log('device-profile.logic: all assertions passed');
