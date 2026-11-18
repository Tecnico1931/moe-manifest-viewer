/**
 * Peloton device profiles for the hls.js player.
 *
 * THE NUMBERS BELOW ARE APPROXIMATIONS, NOT MEASUREMENTS. Edit them freely: they are the only place
 * that defines a profile. Everything else (dropdown, chip, throttling, level capping) reads this list.
 */
export type StartLevelPolicy = 'top' | 'auto';

export interface DeviceProfile {
  id: string;
  label: string;
  /** Highest rung height the device is allowed to play. null = no limit. */
  maxHeight: number | null;
  /** 'top' = start on the highest allowed rung (what Peloton devices are known to do); 'auto' = hls.js decides. */
  startLevel: StartLevelPolicy;
  /** Simulated throughput in Mbps. null = no throttling. */
  bandwidthMbps: number | null;
  /** Fixed latency in ms added before each response. */
  latencyMs: number;
}

export const DEFAULT_DEVICE_PROFILE_ID = 'default';

export const DEVICE_PROFILES: ReadonlyArray<DeviceProfile> = [
  { id: DEFAULT_DEVICE_PROFILE_ID, label: 'Default (no limits)', maxHeight: null, startLevel: 'auto', bandwidthMbps: null, latencyMs: 0 },
  { id: 'bike-gen1', label: 'Bike (gen 1)', maxHeight: 1080, startLevel: 'top', bandwidthMbps: 12, latencyMs: 40 },
  { id: 'bike-plus', label: 'Bike+', maxHeight: 1080, startLevel: 'top', bandwidthMbps: 25, latencyMs: 30 },
  { id: 'tread', label: 'Tread', maxHeight: 1080, startLevel: 'top', bandwidthMbps: 25, latencyMs: 30 },
  { id: 'row', label: 'Row', maxHeight: 1080, startLevel: 'top', bandwidthMbps: 25, latencyMs: 30 },
  { id: 'guide', label: 'Guide (TV)', maxHeight: 1080, startLevel: 'auto', bandwidthMbps: 20, latencyMs: 30 },
  { id: 'phone', label: 'Phone (cellular)', maxHeight: 720, startLevel: 'auto', bandwidthMbps: 4, latencyMs: 120 },
  { id: 'slow-wifi', label: 'Slow Wi-Fi', maxHeight: 1080, startLevel: 'top', bandwidthMbps: 3, latencyMs: 60 },
];
