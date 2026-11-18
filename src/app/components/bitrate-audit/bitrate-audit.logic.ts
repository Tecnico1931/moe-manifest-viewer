/** Pure logic for the "Declared vs delivered" panel. No Angular imports. */

export interface AuditRecord {
  id?: number;
  url: string;
  kind: string;
  level?: number;
  bandwidthDeclared?: number;
  averageBandwidthDeclared?: number;
  resolution?: string;
  audioGroup?: string;
  trackName?: string;
  durationSec?: number;
  bytes?: number;
  error?: string;
}

export const MIN_SEGMENTS = 3;
export const AVG_FLAG_RATIO = 1.1;

export interface MediaStats {
  segments: number;
  seconds: number;
  bytes: number;
  avgKbps?: number;
  peakKbps?: number;
}

export interface VideoRow extends MediaStats {
  level?: number;
  resolution?: string;
  bandwidthKbps?: number;
  averageBandwidthKbps?: number;
  audioGroup?: string;
  isTs: boolean;
  /** measured average / AVERAGE-BANDWIDTH, percent (video only) */
  avgPct?: number;
  /** measured peak / BANDWIDTH, percent (video only) */
  peakPct?: number;
  /** Separate audio rendition used for the combined line, if the stream has one. */
  audioTrack?: AudioRow;
  combinedAvgKbps?: number;
  combinedPeakKbps?: number;
  combinedAvgPct?: number;
  combinedPeakPct?: number;
  flagAvg: boolean;
  flagPeak: boolean;
  isFewSegments: boolean;
  /** Median CMCD `br` (kbps) the player sent on this rendition's segment requests (query-mode CMCD only). */
  cmcdBrKbps?: number;
  /** CMCD br is under 20% of declared BANDWIDTH: the player is reporting the wrong bitrate. */
  flagCmcdBr: boolean;
}

export interface AudioRow extends MediaStats {
  name: string;
  group?: string;
}

export interface AuditResult {
  video: VideoRow[];
  audio: AudioRow[];
}

const isFinitePositive = (n: unknown): n is number => typeof n === 'number' && isFinite(n) && n > 0;
const toKbps = (bps?: number): number | undefined => (isFinitePositive(bps) ? bps / 1000 : undefined);
const pct = (value?: number, base?: number): number | undefined =>
  value !== undefined && base !== undefined && base > 0 ? (value / base) * 100 : undefined;
const isTsUrl = (url: string): boolean => /\.ts$/i.test(url.split(/[?#]/)[0]);

/** Segments usable for measuring: no error, bytes and duration both positive. Re-downloads of one URL count once. */
const measurable = (records: AuditRecord[]): AuditRecord[] => {
  const latest = new Map<string, AuditRecord>();
  records
    .filter((r) => !r.error && isFinitePositive(r.bytes) && isFinitePositive(r.durationSec))
    .forEach((r) => latest.set(r.url, r));
  return Array.from(latest.values());
};

export const mediaStats = (records: AuditRecord[]): MediaStats => {
  const segs = measurable(records);
  const bytes = segs.reduce((sum, r) => sum + (r.bytes as number), 0);
  const seconds = segs.reduce((sum, r) => sum + (r.durationSec as number), 0);
  const peak = segs.reduce((max, r) => Math.max(max, ((r.bytes as number) * 8) / (r.durationSec as number)), 0);
  return {
    segments: segs.length,
    seconds,
    bytes,
    avgKbps: seconds > 0 ? (bytes * 8) / seconds / 1000 : undefined,
    peakKbps: segs.length ? peak / 1000 : undefined,
  };
};

const audioRows = (records: AuditRecord[]): AudioRow[] => {
  const byTrack = new Map<string, AuditRecord[]>();
  records
    .filter((r) => r.kind === 'audio-segment')
    .forEach((r) => {
      const key = `${r.audioGroup ?? ''}\u0000${r.trackName ?? ''}`;
      byTrack.set(key, [...(byTrack.get(key) ?? []), r]);
    });
  return Array.from(byTrack.values()).map((recs) => ({
    name: recs[0].trackName ?? 'audio',
    group: recs[0].audioGroup,
    ...mediaStats(recs),
  }));
};

/** The audio rendition a variant would carry: same group when known, else any; the highest-bitrate one (worst case). */
const pickAudio = (audio: AudioRow[], group?: string): AudioRow | undefined => {
  const inGroup = group ? audio.filter((a) => a.group === group) : [];
  const pool = (inGroup.length ? inGroup : audio).filter((a) => a.avgKbps !== undefined);
  return pool.reduce<AudioRow | undefined>((best, a) => (!best || (a.avgKbps as number) > (best.avgKbps as number) ? a : best), undefined);
};

export const CMCD_BR_MIN_RATIO = 0.2;

/** CMCD `br` from a request URL's CMCD query parameter (e.g. ?CMCD=br%3D3200%2Cd%3D6006), in kbps. */
export const cmcdBrFromUrl = (url: string): number | undefined => {
  const m = /[?&]CMCD=([^&#]*)/.exec(url);
  if (!m) {
    return undefined;
  }
  let value: string;
  try {
    value = decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
  const br = value.split(',').map((kv) => kv.trim().split('=')).find(([k]) => k === 'br');
  const n = br && br[1] !== undefined ? Number(br[1]) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const median = (xs: number[]): number | undefined => {
  if (!xs.length) {
    return undefined;
  }
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const buildAudit = (records: AuditRecord[]): AuditResult => {
  const audio = audioRows(records);
  const levelKeys = Array.from(
    new Set(records.filter((r) => ['variant', 'video-segment'].includes(r.kind) && r.level !== undefined).map((r) => r.level as number))
  );
  const hasUnleveled = records.some((r) => r.kind === 'video-segment' && r.level === undefined);
  const keys: Array<number | undefined> = [...levelKeys.sort((a, b) => a - b), ...(hasUnleveled ? [undefined] : [])];

  const video = keys.map((level) => {
    const mine = records.filter((r) => ['variant', 'video-segment'].includes(r.kind) && r.level === level);
    const segs = mine.filter((r) => r.kind === 'video-segment');
    const declared = mine.find((r) => r.bandwidthDeclared !== undefined || r.averageBandwidthDeclared !== undefined) ?? mine[0];
    const stats = mediaStats(segs);
    const bandwidthKbps = toKbps(declared?.bandwidthDeclared);
    const averageBandwidthKbps = toKbps(declared?.averageBandwidthDeclared);
    const audioTrack = audio.length ? pickAudio(audio, declared?.audioGroup) : undefined;
    const combinedAvgKbps = audioTrack && stats.avgKbps !== undefined ? stats.avgKbps + (audioTrack.avgKbps as number) : undefined;
    const combinedPeakKbps = audioTrack && stats.peakKbps !== undefined ? stats.peakKbps + (audioTrack.peakKbps as number) : undefined;
    // Declared values include audio, so with separate audio the combined figure is the like-for-like one.
    const effAvg = combinedAvgKbps ?? stats.avgKbps;
    const effPeak = combinedPeakKbps ?? stats.peakKbps;
    const cmcdBrKbps = median(segs.map((r) => cmcdBrFromUrl(r.url)).filter((n): n is number => n !== undefined));
    return {
      level,
      resolution: declared?.resolution,
      bandwidthKbps,
      averageBandwidthKbps,
      audioGroup: declared?.audioGroup,
      isTs: segs.some((r) => isTsUrl(r.url)),
      ...stats,
      avgPct: pct(stats.avgKbps, averageBandwidthKbps),
      peakPct: pct(stats.peakKbps, bandwidthKbps),
      audioTrack,
      combinedAvgKbps,
      combinedPeakKbps,
      combinedAvgPct: pct(combinedAvgKbps, averageBandwidthKbps),
      combinedPeakPct: pct(combinedPeakKbps, bandwidthKbps),
      flagAvg: effAvg !== undefined && averageBandwidthKbps !== undefined && effAvg > averageBandwidthKbps * AVG_FLAG_RATIO,
      flagPeak: effPeak !== undefined && bandwidthKbps !== undefined && effPeak > bandwidthKbps,
      isFewSegments: stats.segments < MIN_SEGMENTS,
      cmcdBrKbps,
      flagCmcdBr: cmcdBrKbps !== undefined && bandwidthKbps !== undefined && cmcdBrKbps < bandwidthKbps * CMCD_BR_MIN_RATIO,
    } as VideoRow;
  });
  return { video, audio };
};

const cell = (n: number | undefined, digits = 0): string => (n === undefined ? '—' : n.toFixed(digits));

const flagText = (r: VideoRow): string =>
  [
    r.flagAvg ? 'avg>110%' : '',
    r.flagPeak ? 'peak>BANDWIDTH' : '',
    r.isFewSegments ? 'few segments' : '',
    r.flagCmcdBr ? 'CMCD br<20%' : '',
  ]
    .filter(Boolean)
    .join(',') || '—';

export const toTsv = (result: AuditResult): string => {
  const head = [
    'level', 'resolution', 'container', 'segments', 'seconds', 'declared BANDWIDTH kbps', 'declared AVERAGE-BANDWIDTH kbps',
    'measured avg kbps', 'measured peak kbps', 'avg/AVERAGE-BANDWIDTH %', 'peak/BANDWIDTH %', 'video+audio avg kbps', 'flag',
    'CMCD br kbps',
  ];
  const lines = result.video.map((r) =>
    [
      r.level === undefined ? '—' : String(r.level), r.resolution ?? '—', r.isTs ? 'TS' : '—', String(r.segments), cell(r.seconds, 1),
      cell(r.bandwidthKbps), cell(r.averageBandwidthKbps), cell(r.avgKbps), cell(r.peakKbps), cell(r.avgPct), cell(r.peakPct),
      cell(r.combinedAvgKbps), flagText(r), cell(r.cmcdBrKbps),
    ].join('\t')
  );
  const audioLines = result.audio.map((a) =>
    ['audio', a.name, a.group ?? '—', String(a.segments), cell(a.seconds, 1), '—', '—', cell(a.avgKbps), cell(a.peakKbps), '—', '—', '—', '—', '—'].join('\t')
  );
  return [head.join('\t'), ...lines, ...audioLines].join('\n');
};
