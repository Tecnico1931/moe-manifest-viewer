import * as assert from 'assert';
import { resolveDeviceProfile } from './device-profile.logic';
import { withDeviceProfileThrottle } from './device-profile.throttle-loader';

(global as any).self = global;
(global as any).performance = (global as any).performance || require('perf_hooks').performance;

// Fake base loader: "downloads" 250 kB instantly and reports success.
class FakeBase {
  public stats: any = { loaded: 0, loading: { start: 0, first: 0, end: 0 } };
  public load(context: any, config: any, callbacks: any) {
    this.stats.loading.start = performance.now();
    this.stats.loaded = 250000;
    callbacks.onSuccess({ url: 'x', data: '' }, this.stats, context, null);
  }
  public abort() {}
  public destroy() {}
}

const run = (profileId: string): Promise<number> =>
  new Promise((resolve) => {
    const Loader = withDeviceProfileThrottle(FakeBase, () => resolveDeviceProfile(profileId));
    const loader = new Loader();
    loader.load({}, {}, { onSuccess: (r: any, stats: any) => resolve(stats.loading.end - stats.loading.start) });
  });

(async () => {
  // 250 kB at 12 Mbps = 166.7 ms transfer + 40 ms latency = ~206.7 ms
  const slow = await run('bike-gen1');
  assert.ok(slow >= 205 && slow < 240, `bike-gen1 took ${slow}`);
  // default profile: passthrough, no delay
  const none = await run('default');
  assert.ok(none < 20, `default took ${none}`);
  console.log(`throttle-loader: bike-gen1 ${slow.toFixed(0)} ms, default ${none.toFixed(0)} ms`);
})();
