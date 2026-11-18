import { DEFAULT_DEVICE_PROFILE_ID, DEVICE_PROFILES, DeviceProfile } from '../../shared/models/device-profiles';

export interface LevelLike {
  height?: number;
  bitrate?: number;
}

export const getDeviceProfile = (id: string | null | undefined): DeviceProfile | undefined => DEVICE_PROFILES.find((p) => p.id === id);

/** Unknown, empty or missing ids fall back to the default (no limits) profile. */
export const resolveDeviceProfile = (id: string | null | undefined): DeviceProfile =>
  getDeviceProfile(id) || (getDeviceProfile(DEFAULT_DEVICE_PROFILE_ID) as DeviceProfile);

/** True when the profile changes nothing about playback. */
export const isNoopProfile = (p: DeviceProfile): boolean =>
  p.maxHeight === null && p.bandwidthMbps === null && p.latencyMs === 0 && p.startLevel === 'auto';

/**
 * Milliseconds to hold a finished response so the request looks like it took
 * latencyMs + bytes*8 / cap, measured from the request start. Never negative: a slow network can't be sped up.
 */
export const throttleDelayMs = (bytes: number, elapsedMs: number, bandwidthMbps: number | null, latencyMs: number): number => {
  const transferMs = bandwidthMbps && bandwidthMbps > 0 ? (bytes * 8) / (bandwidthMbps * 1000) : 0;
  return Math.max(0, latencyMs + transferMs - elapsedMs);
};

/** Indexes (into the given order) of levels at or under maxHeight. Levels with unknown height (audio-only) are kept. */
export const allowedLevelIndexes = (levels: LevelLike[], maxHeight: number | null): number[] =>
  levels.map((l, i) => i).filter((i) => maxHeight === null || !levels[i].height || (levels[i].height as number) <= maxHeight);

/** Highest allowed level index (hls.js sorts levels by ascending bitrate). If nothing fits, the shortest level. -1 for no levels. */
export const capLevelIndex = (levels: LevelLike[], maxHeight: number | null): number => {
  if (!levels.length) {
    return -1;
  }
  const allowed = allowedLevelIndexes(levels, maxHeight);
  if (allowed.length) {
    return Math.max(...allowed);
  }
  return levels.reduce((best, l, i) => ((l.height || 0) < (levels[best].height || 0) ? i : best), 0);
};

/** The level to start on: 'top' = best-bitrate allowed level, 'auto' = -1 (let hls.js choose). */
export const startLevelIndex = (levels: LevelLike[], profile: DeviceProfile): number => {
  if (profile.startLevel !== 'top') {
    return -1;
  }
  const allowed = allowedLevelIndexes(levels, profile.maxHeight);
  if (!allowed.length) {
    return capLevelIndex(levels, profile.maxHeight);
  }
  return allowed.reduce((best, i) => ((levels[i].bitrate || 0) > (levels[best].bitrate || 0) ? i : best), allowed[0]);
};

/** hls.js config fragments known before the manifest is parsed. */
export const hlsConfigOverrides = (profile: DeviceProfile): { [key: string]: any } => {
  if (isNoopProfile(profile)) {
    return {};
  }
  const overrides: { [key: string]: any } = { capLevelToPlayerSize: false };
  if (profile.bandwidthMbps) {
    // Seed ABR with the simulated throughput so 'auto' start picks a rung the device could sustain.
    overrides.abrEwmaDefaultEstimate = profile.bandwidthMbps * 1e6;
  }
  return overrides;
};

export const describeProfile = (p: DeviceProfile): string => {
  const parts = [
    p.maxHeight ? `max ${p.maxHeight}p` : 'no resolution cap',
    `start ${p.startLevel}`,
    p.bandwidthMbps ? `${p.bandwidthMbps} Mbps` : 'unthrottled',
    p.latencyMs ? `+${p.latencyMs} ms` : 'no added latency',
  ];
  return parts.join(', ');
};
