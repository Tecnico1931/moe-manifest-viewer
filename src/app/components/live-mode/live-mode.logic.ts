/** Pure logic for the Live panel. No Angular, no DOM; all times are ms unless a name says Sec. */

/** Small, URL-free digest of a media playlist, stored on the request record (no tokens can leak through it). */
export interface PlaylistSummary {
  mediaSequence: number;
  targetDuration?: number;
  endList: boolean;
  segmentCount: number;
  lastDuration?: number;
  /** PROGRAM-DATE-TIME of the newest segment's start (epoch ms), from the nearest tag plus EXTINF durations. */
  lastSegStartPdtMs?: number;
}

export interface ReloadRecord {
  tRequest: number;
  tFirstByte?: number;
  tLoaded?: number;
  level?: number;
  playlist?: PlaylistSummary;
}

export interface ReloadRow {
  /** performance.now() when the playlist finished loading. */
  t: number;
  intervalMs?: number;
  headSn: number;
  mediaSequence: number;
  seqAdvance?: number;
  newSegments?: number;
  stale: boolean;
  /** Wall clock minus end of the newest segment (PDT + duration) at load time: how old the playlist head is. */
  availabilityLagSec?: number;
}

export interface LiveFlag {
  id: 'refresh-slow' | 'latency-high' | 'stale-reloads';
  message: string;
}

export interface LiveAnalysis {
  /** undefined until a media playlist has been seen. */
  isLive?: boolean;
  targetDurationSec?: number;
  rows: ReloadRow[];
  avgIntervalMs?: number;
  maxIntervalMs?: number;
  staleTotal: number;
  staleInARow: number;
  avgSeqAdvance?: number;
  lastAvailabilityLagSec?: number;
  /** Change of availability lag over time; sustained non-zero values mean PDT and wall clock drift apart. */
  driftSecPerMin?: number;
}

export interface LatencySample {
  /** performance.now() */
  t: number;
  latencySec: number;
}

export interface FragmentLike {
  start: number;
  duration: number;
  programDateTime?: number | null;
}

export const REFRESH_FACTOR = 1.5;
export const LATENCY_FACTOR = 3;
export const STALE_LIMIT = 2;
const RECENT_INTERVALS = 5;

const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export const summarizePlaylist = (text: string): PlaylistSummary | undefined => {
  if (!text || text.indexOf('#EXTM3U') === -1 || text.indexOf('#EXT-X-STREAM-INF') !== -1) {
    return undefined;
  }
  const summary: PlaylistSummary = { mediaSequence: 0, endList: false, segmentCount: 0 };
  let nextPdt: number | undefined;
  let pendingDuration: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      summary.mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      summary.targetDuration = parseFloat(line.slice(22)) || undefined;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      summary.endList = true;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const parsed = Date.parse(line.slice(25));
      nextPdt = isNaN(parsed) ? undefined : parsed;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
    } else if (line && !line.startsWith('#') && pendingDuration !== undefined) {
      summary.segmentCount++;
      summary.lastDuration = pendingDuration;
      summary.lastSegStartPdtMs = nextPdt;
      nextPdt = nextPdt === undefined ? undefined : nextPdt + pendingDuration * 1000;
      pendingDuration = undefined;
    }
  }
  return summary.segmentCount > 0 ? summary : undefined;
};

/** Reload series for the level that was loaded most recently. Records need not be sorted. */
export const analyzeReloads = (records: ReloadRecord[], wallOffsetMs: number): LiveAnalysis => {
  const withPlaylist = records.filter((r) => r.playlist && r.tLoaded !== undefined).sort((a, b) => a.tRequest - b.tRequest);
  if (!withPlaylist.length) {
    return { rows: [], staleTotal: 0, staleInARow: 0 };
  }
  const latest = withPlaylist[withPlaylist.length - 1];
  const series = withPlaylist.filter((r) => r.level === latest.level);
  const rows: ReloadRow[] = series.map((rec, i) => {
    const pl = rec.playlist as PlaylistSummary;
    const prev = i > 0 ? (series[i - 1].playlist as PlaylistSummary) : undefined;
    const headSn = pl.mediaSequence + pl.segmentCount - 1;
    const newSegments = prev ? Math.max(0, headSn - (prev.mediaSequence + prev.segmentCount - 1)) : undefined;
    const lastEnd = pl.lastSegStartPdtMs === undefined ? undefined : pl.lastSegStartPdtMs + (pl.lastDuration || 0) * 1000;
    return {
      t: rec.tLoaded as number,
      intervalMs: i > 0 ? rec.tRequest - series[i - 1].tRequest : undefined,
      headSn,
      mediaSequence: pl.mediaSequence,
      seqAdvance: prev ? pl.mediaSequence - prev.mediaSequence : undefined,
      newSegments,
      stale: newSegments === 0,
      availabilityLagSec: lastEnd === undefined ? undefined : (wallOffsetMs + (rec.tLoaded as number) - lastEnd) / 1000,
    };
  });
  const intervals = rows.map((r) => r.intervalMs).filter((v): v is number => v !== undefined);
  let staleInARow = 0;
  for (let i = rows.length - 1; i > 0 && rows[i].stale; i--) {
    staleInARow++;
  }
  const lags = rows.filter((r) => r.availabilityLagSec !== undefined);
  const drift =
    lags.length >= 2 && lags[lags.length - 1].t > lags[0].t
      ? ((lags[lags.length - 1].availabilityLagSec as number) - (lags[0].availabilityLagSec as number)) /
        ((lags[lags.length - 1].t - lags[0].t) / 60000)
      : undefined;
  const last = latest.playlist as PlaylistSummary;
  return {
    isLive: !last.endList,
    targetDurationSec: last.targetDuration,
    rows,
    avgIntervalMs: mean(intervals.slice(-RECENT_INTERVALS)),
    maxIntervalMs: intervals.length ? Math.max(...intervals) : undefined,
    staleTotal: rows.filter((r) => r.stale).length,
    staleInARow,
    avgSeqAdvance: mean(rows.map((r) => r.seqAdvance).filter((v): v is number => v !== undefined)),
    lastAvailabilityLagSec: lags.length ? lags[lags.length - 1].availabilityLagSec : undefined,
    driftSecPerMin: drift,
  };
};

/** Program date-time (epoch ms) at the playhead, from the loaded fragment list. Undefined without PDT tags. */
export const playheadPdtMs = (fragments: FragmentLike[], currentTime: number): number | undefined => {
  const frag = fragments.find((f) => f.programDateTime != null && currentTime >= f.start && currentTime < f.start + f.duration);
  return frag ? (frag.programDateTime as number) + (currentTime - frag.start) * 1000 : undefined;
};

export const latencySec = (playheadPdt: number | undefined, wallNowMs: number): number | undefined =>
  playheadPdt === undefined ? undefined : (wallNowMs - playheadPdt) / 1000;

export const evaluateFlags = (analysis: LiveAnalysis, latestLatencySec?: number): LiveFlag[] => {
  const flags: LiveFlag[] = [];
  const target = analysis.targetDurationSec;
  if (!analysis.isLive || !target) {
    return flags;
  }
  if (analysis.avgIntervalMs !== undefined && analysis.avgIntervalMs > REFRESH_FACTOR * target * 1000) {
    flags.push({
      id: 'refresh-slow',
      message: `Playlist refresh every ${(analysis.avgIntervalMs / 1000).toFixed(1)} s is over ${REFRESH_FACTOR}x the target duration (${target} s).`,
    });
  }
  if (latestLatencySec !== undefined && latestLatencySec > LATENCY_FACTOR * target) {
    flags.push({
      id: 'latency-high',
      message: `Live edge latency ${latestLatencySec.toFixed(1)} s is over ${LATENCY_FACTOR}x the target duration (${target} s).`,
    });
  }
  if (analysis.staleInARow >= STALE_LIMIT) {
    flags.push({ id: 'stale-reloads', message: `${analysis.staleInARow} playlist reloads in a row brought no new segment.` });
  }
  return flags;
};

/** Join time: first manifest request to the first frame, both performance.now() values. */
export const joinTimeMs = (firstRequest: number | undefined, firstFrame: number | undefined): number | undefined =>
  firstRequest === undefined || firstFrame === undefined ? undefined : Math.max(0, firstFrame - firstRequest);

/** Points for an SVG polyline, scaled into width x height. Keeps the series order. */
export const sparklinePoints = (samples: LatencySample[], width: number, height: number): string => {
  if (samples.length < 2) {
    return '';
  }
  const t0 = samples[0].t;
  const span = samples[samples.length - 1].t - t0 || 1;
  const max = Math.max(1, ...samples.map((s) => s.latencySec));
  return samples.map((s) => `${(((s.t - t0) / span) * width).toFixed(1)},${(height - (s.latencySec / max) * height).toFixed(1)}`).join(' ');
};
