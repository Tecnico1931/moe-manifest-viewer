import * as HlsTypes from 'hls.js';
import { DeviceProfile } from '../../shared/models/device-profiles';
import { throttleDelayMs } from './device-profile.logic';

/**
 * Wraps an hls.js loader class (the app's recording loader) so each finished response is held back until
 * latencyMs + bytes*8/cap has passed since the request started. This can only slow responses down after
 * they have arrived; it cannot make a slow network faster.
 */
export const withDeviceProfileThrottle = (Base: any, getProfile: () => DeviceProfile | null): any =>
  class extends Base {
    private throttleTimer?: number;

    public load(
      context: HlsTypes.LoaderContext,
      config: HlsTypes.LoaderConfiguration,
      callbacks: HlsTypes.LoaderCallbacks<HlsTypes.LoaderContext>
    ): void {
      const profile = getProfile();
      if (!profile || (!profile.bandwidthMbps && !profile.latencyMs)) {
        return super.load(context, config, callbacks);
      }
      const wrapped = {
        ...callbacks,
        onSuccess: (response: HlsTypes.LoaderResponse, stats: HlsTypes.LoaderStats, ctx: HlsTypes.LoaderContext, networkDetails: any) => {
          const elapsed = self.performance.now() - stats.loading.start;
          const delay = throttleDelayMs(stats.loaded, elapsed, profile.bandwidthMbps, profile.latencyMs);
          const deliver = () => {
            this.throttleTimer = undefined;
            // hls.js and the request log read the end time as "download finished": make it the throttled time.
            stats.loading.end = self.performance.now();
            (this as any).logUpdate?.({ tLoaded: stats.loading.end });
            callbacks.onSuccess(response, stats, ctx, networkDetails);
          };
          if (delay > 0) {
            this.throttleTimer = self.setTimeout(deliver, delay);
          } else {
            deliver();
          }
        },
      };
      super.load(context, config, wrapped);
    }

    public abort(): void {
      self.clearTimeout(this.throttleTimer);
      super.abort();
    }

    public destroy(): void {
      self.clearTimeout(this.throttleTimer);
      super.destroy();
    }
  };
