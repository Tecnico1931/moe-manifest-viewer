/** Pure helpers for the Audio tracks panel: playlist parsing, TS audio extraction and BS.1770 loudness maths. */

export interface AudioRendition {
  name: string;
  language?: string;
  groupId?: string;
  isDefault: boolean;
  channels?: string;
  uri?: string;
}

export interface PlaylistSegment {
  index: number;
  url: string;
  duration: number;
  byteRange?: { length: number; offset?: number };
}

export interface MediaPlaylist {
  segments: PlaylistSegment[];
  mapUrl?: string;
  mapByteRange?: { length: number; offset?: number };
}

export interface LoudnessResult {
  /** Integrated loudness in LKFS, -Infinity when nothing passes the gates. */
  lufs: number;
  blocks: number;
  gatedBlocks: number;
}

export interface TrackMeasurement extends LoudnessResult {
  samplePeakDb: number;
  truePeakDb: number;
  rmsDb: number;
  channels: number;
  sampleRate: number;
  durationSec: number;
}

export const LU_SPREAD_WARN = 2;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_SEC = 0.4;
const BLOCK_STEP_SEC = 0.1;

/* ---------------------------------- playlists ---------------------------------- */

export const parseAttributes = (line: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match = re.exec(line);
  while (match) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
    match = re.exec(line);
  }
  return attrs;
};

export const resolveUrl = (relative: string, base: string): string => {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
};

export const parseMasterAudio = (text: string, baseUrl: string): AudioRendition[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('#EXT-X-MEDIA:'))
    .map((line) => parseAttributes(line.slice('#EXT-X-MEDIA:'.length)))
    .filter((attrs) => attrs.TYPE === 'AUDIO')
    .map((attrs) => ({
      name: attrs.NAME || attrs.LANGUAGE || attrs['GROUP-ID'] || 'audio',
      language: attrs.LANGUAGE,
      groupId: attrs['GROUP-ID'],
      isDefault: attrs.DEFAULT === 'YES',
      channels: attrs.CHANNELS,
      uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : undefined,
    }));

const parseByteRange = (value: string, previousEnd: number): { length: number; offset: number } => {
  const [len, off] = value.split('@');
  const length = parseInt(len, 10);
  return { length, offset: off !== undefined ? parseInt(off, 10) : previousEnd };
};

export const parseMediaPlaylist = (text: string, baseUrl: string): MediaPlaylist => {
  const segments: PlaylistSegment[] = [];
  let mapUrl: string | undefined;
  let mapByteRange: MediaPlaylist['mapByteRange'];
  let duration = 0;
  let pendingRange: { length: number; offset: number } | undefined;
  let rangeEnd = 0;
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17), rangeEnd);
      rangeEnd = pendingRange.offset + pendingRange.length;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(11));
      mapUrl = attrs.URI ? resolveUrl(attrs.URI, baseUrl) : undefined;
      mapByteRange = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : undefined;
    } else if (line && !line.startsWith('#')) {
      segments.push({ index: segments.length, url: resolveUrl(line, baseUrl), duration, byteRange: pendingRange });
      pendingRange = undefined;
      duration = 0;
    }
  });
  return { segments, mapUrl, mapByteRange };
};

/** Segment containing `playhead` seconds, else the 3rd segment (index 2); always clamped to the playlist. */
export const pickSegmentIndex = (segments: PlaylistSegment[], playhead?: number): number => {
  if (!segments.length) {
    return 0;
  }
  if (playhead !== undefined && isFinite(playhead) && playhead > 0) {
    let start = 0;
    for (const segment of segments) {
      if (playhead < start + segment.duration) {
        return segment.index;
      }
      start += segment.duration;
    }
  }
  return Math.min(2, segments.length - 1);
};

export interface LoggedAudioSegment {
  trackName?: string;
  audioGroup?: string;
  bytes?: number;
  durationSec?: number;
}

/** Mean kb/s (bytes * 8 / duration) of downloaded audio segments per track name. */
export const measuredKbpsByTrack = (records: LoggedAudioSegment[]): Record<string, { kbps: number; segments: number }> => {
  const sums: Record<string, { bits: number; sec: number; segments: number }> = {};
  records.forEach((record) => {
    if (!record.trackName || !record.bytes || !record.durationSec) {
      return;
    }
    const sum = sums[record.trackName] || { bits: 0, sec: 0, segments: 0 };
    sums[record.trackName] = { bits: sum.bits + record.bytes * 8, sec: sum.sec + record.durationSec, segments: sum.segments + 1 };
  });
  return Object.keys(sums).reduce(
    (out, name) => ({ ...out, [name]: { kbps: sums[name].bits / sums[name].sec / 1000, segments: sums[name].segments } }),
    {} as Record<string, { kbps: number; segments: number }>
  );
};

/* ------------------------------ MPEG-TS audio (ADTS) ------------------------------ */

export const isMpegTs = (data: Uint8Array): boolean => data.length >= 376 && data[0] === 0x47 && (data[188] === 0x47 || data[192] === 0x47);

/**
 * Concatenates the payloads of MPEG audio PES streams (stream_id 0xC0-0xDF) from a TS segment.
 * For AAC-in-TS that is a raw ADTS stream, which decodeAudioData accepts. Returns undefined when the TS has no such
 * stream (e.g. AC-3 / E-AC-3 use private stream 1 and are not decodable here).
 */
export const extractAdtsFromTs = (ts: Uint8Array): Uint8Array | undefined => {
  const audioPids = new Set<number>();
  const chunks: Uint8Array[] = [];
  for (let p = 0; p + 188 <= ts.length; p += 188) {
    if (ts[p] !== 0x47) {
      continue;
    }
    const pusi = (ts[p + 1] & 0x40) !== 0;
    const pid = ((ts[p + 1] & 0x1f) << 8) | ts[p + 2];
    const afc = (ts[p + 3] >> 4) & 3;
    if (!(afc & 1)) {
      continue;
    }
    let start = p + 4 + (afc & 2 ? 1 + ts[p + 4] : 0);
    const end = p + 188;
    if (pusi) {
      const isPes = ts[start] === 0 && ts[start + 1] === 0 && ts[start + 2] === 1;
      const streamId = ts[start + 3];
      if (isPes && streamId >= 0xc0 && streamId <= 0xdf) {
        audioPids.add(pid);
        start += 9 + ts[start + 8];
      } else {
        audioPids.delete(pid);
        continue;
      }
    }
    if (audioPids.has(pid) && start < end) {
      chunks.push(ts.subarray(start, end));
    }
  }
  if (!chunks.length) {
    return undefined;
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((offset, c) => {
    out.set(c, offset);
    return offset + c.length;
  }, 0);
  return out;
};

/* ---------------------------------- loudness ---------------------------------- */

interface Biquad {
  b: [number, number, number];
  a: [number, number]; // a1, a2 (a0 = 1)
}

/**
 * BS.1770 K-weighting: stage 1 high shelf (+4 dB, head model) and stage 2 RLB high-pass. Coefficients are derived
 * analytically so any sample rate works; at 48 kHz they equal the published values
 * (b = 1.53512485958697, -2.69169618940638, 1.19839281085285; a = -1.69065929318241, 0.73248077421585 and
 * b = 1, -2, 1; a = -1.99004745483398, 0.99007225036621).
 */
export const kWeightingFilters = (fs: number): [Biquad, Biquad] => {
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfFc = 1681.9744509555319;
  const k1 = Math.tan((Math.PI * shelfFc) / fs);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k1 / shelfQ + k1 * k1;
  const shelf: Biquad = {
    b: [(vh + (vb * k1) / shelfQ + k1 * k1) / a0, (2 * (k1 * k1 - vh)) / a0, (vh - (vb * k1) / shelfQ + k1 * k1) / a0],
    a: [(2 * (k1 * k1 - 1)) / a0, (1 - k1 / shelfQ + k1 * k1) / a0],
  };
  const hpQ = 0.5003270373238773;
  const hpFc = 38.13547087613982;
  const k2 = Math.tan((Math.PI * hpFc) / fs);
  const a0h = 1 + k2 / hpQ + k2 * k2;
  const highpass: Biquad = { b: [1, -2, 1], a: [(2 * (k2 * k2 - 1)) / a0h, (1 - k2 / hpQ + k2 * k2) / a0h] };
  return [shelf, highpass];
};

const applyBiquad = (x: Float32Array | Float64Array, f: Biquad): Float64Array => {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = f.b[0] * x[i] + f.b[1] * x1 + f.b[2] * x2 - f.a[0] * y1 - f.a[1] * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = out;
    y[i] = out;
  }
  return y;
};

export const kWeight = (x: Float32Array | Float64Array, fs: number): Float64Array =>
  kWeightingFilters(fs).reduce<Float32Array | Float64Array>((signal, filter) => applyBiquad(signal, filter), x) as Float64Array;

/** BS.1770 channel weights: surrounds +1.5 dB, LFE excluded (6 channels assumed L R C LFE Ls Rs). */
export const channelWeights = (count: number): number[] => {
  if (count === 6) {
    return [1, 1, 1, 0, 1.41, 1.41];
  }
  if (count === 5) {
    return [1, 1, 1, 1.41, 1.41];
  }
  return new Array(count).fill(1);
};

const toLufs = (z: number): number => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);

/** Integrated loudness (BS.1770-4 gating: 400 ms blocks, 75 % overlap, -70 LKFS absolute and -10 LU relative gate). */
export const integratedLoudness = (channels: Array<Float32Array | Float64Array>, fs: number): LoudnessResult => {
  const none: LoudnessResult = { lufs: -Infinity, blocks: 0, gatedBlocks: 0 };
  if (!channels.length || !channels[0].length) {
    return none;
  }
  const weights = channelWeights(channels.length);
  const weighted = channels.map((c) => kWeight(c, fs));
  const blockLen = Math.round(BLOCK_SEC * fs);
  const step = Math.round(BLOCK_STEP_SEC * fs);
  const length = channels[0].length;
  if (length < blockLen) {
    return none;
  }
  const energies: number[] = [];
  for (let start = 0; start + blockLen <= length; start += step) {
    const z = weighted.reduce((sum, ch, c) => {
      if (!weights[c]) {
        return sum;
      }
      let ms = 0;
      for (let i = start; i < start + blockLen; i++) {
        ms += ch[i] * ch[i];
      }
      return sum + weights[c] * (ms / blockLen);
    }, 0);
    energies.push(z);
  }
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  const aboveAbsolute = energies.filter((z) => toLufs(z) > ABSOLUTE_GATE_LUFS);
  if (!aboveAbsolute.length) {
    return { ...none, blocks: energies.length };
  }
  const relativeGate = toLufs(mean(aboveAbsolute)) + RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((z) => toLufs(z) > relativeGate);
  return { lufs: gated.length ? toLufs(mean(gated)) : -Infinity, blocks: energies.length, gatedBlocks: gated.length };
};

export const toDb = (linear: number): number => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);

export const samplePeakDb = (channels: Array<Float32Array | Float64Array>): number => {
  let peak = 0;
  channels.forEach((ch) => {
    for (let i = 0; i < ch.length; i++) {
      peak = Math.max(peak, Math.abs(ch[i]));
    }
  });
  return toDb(peak);
};

export const rmsDb = (channels: Array<Float32Array | Float64Array>): number => {
  let count = 0;
  let sum = 0;
  channels.forEach((ch) => {
    count += ch.length;
    for (let i = 0; i < ch.length; i++) {
      sum += ch[i] * ch[i];
    }
  });
  return count ? toDb(Math.sqrt(sum / count)) : -Infinity;
};

const OVERSAMPLE = 4;
const TAPS_PER_PHASE = 12;

const bessel0 = (x: number): number => {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
  }
  return sum;
};

/** Kaiser-windowed sinc polyphase interpolator: phases[p][t] weights sample x[n + 1 - TAPS/2 + t] for fraction p/4. */
export const truePeakPhases = (): number[][] => {
  const beta = 8;
  const half = TAPS_PER_PHASE / 2;
  return Array.from({ length: OVERSAMPLE }, (_, p) => {
    const frac = p / OVERSAMPLE;
    const taps = Array.from({ length: TAPS_PER_PHASE }, (__, t) => {
      const x = t - half + 1 - frac; // distance from the interpolation point, in input samples
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const r = x / half;
      const window = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / bessel0(beta);
      return sinc * window;
    });
    const gain = taps.reduce((a, b) => a + b, 0);
    return taps.map((v) => v / gain);
  });
};

/** True peak (dBTP approximation) by 4x oversampling with a windowed-sinc polyphase FIR. */
export const truePeakDb = (channels: Array<Float32Array | Float64Array>): number => {
  const phases = truePeakPhases();
  const half = TAPS_PER_PHASE / 2;
  const peak = channels.reduce((best, ch) => {
    let chPeak = best;
    for (let n = 0; n < ch.length; n++) {
      chPeak = Math.max(chPeak, Math.abs(ch[n]));
      for (let p = 1; p < OVERSAMPLE; p++) {
        let acc = 0;
        for (let t = 0; t < TAPS_PER_PHASE; t++) {
          const idx = n + t - half + 1;
          if (idx >= 0 && idx < ch.length) {
            acc += phases[p][t] * ch[idx];
          }
        }
        chPeak = Math.max(chPeak, Math.abs(acc));
      }
    }
    return chPeak;
  }, 0);
  return toDb(peak);
};

export const measureTrack = (channels: Array<Float32Array | Float64Array>, sampleRate: number): TrackMeasurement => ({
  ...integratedLoudness(channels, sampleRate),
  samplePeakDb: samplePeakDb(channels),
  truePeakDb: truePeakDb(channels),
  rmsDb: rmsDb(channels),
  channels: channels.length,
  sampleRate,
  durationSec: channels.length ? channels[0].length / sampleRate : 0,
});

/* ------------------------------------ display ------------------------------------ */

export const formatDb = (value: number | undefined, digits = 1): string =>
  value === undefined || !isFinite(value) ? '—' : value.toFixed(digits);

export interface LufsSpread {
  spread: number;
  isWarm: boolean;
}

/** max - min LUFS across the tracks with a finite value; undefined with fewer than two. */
export const lufsSpread = (values: number[]): LufsSpread | undefined => {
  const finite = values.filter((v) => isFinite(v));
  if (finite.length < 2) {
    return undefined;
  }
  const spread = Math.max(...finite) - Math.min(...finite);
  return { spread, isWarm: spread > LU_SPREAD_WARN };
};

/** Bar width in percent for a LUFS value on a -50..0 scale. */
export const lufsBarPercent = (lufs: number): number => (isFinite(lufs) ? Math.max(2, Math.min(100, ((lufs + 50) / 50) * 100)) : 0);
