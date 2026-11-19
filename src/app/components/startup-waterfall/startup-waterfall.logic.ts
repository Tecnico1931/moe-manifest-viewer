/** Pure startup/join-time maths. No Angular imports. Times in the log are performance.now() ms. */

export interface StartupRecord {
  url: string;
  kind: string;
  level?: number;
  bandwidthDeclared?: number;
  resolution?: string;
  bytes?: number;
  tRequest: number;
  tFirstByte?: number;
  tLoaded?: number;
}

export interface WaterfallRow {
  key: string;
  label: string;
  rendition?: string;
  bytes?: number;
  /** ms from session start */
  startMs: number;
  /** end of the waiting (TTFB) part, undefined when tFirstByte is missing */
  firstByteMs?: number;
  /** undefined while the request is still in flight */
  endMs?: number;
  ttfbMs?: number;
  /** TTFB + transfer */
  downloadMs?: number;
}

export interface StartupResult {
  rows: WaterfallRow[];
  /** master start to end of first video segment (and first audio segment when audio is separate) */
  joinMs?: number;
  masterTtfbMs?: number;
  firstSegmentBytes?: number;
  firstSegmentRendition?: string;
  startedOnRung?: string;
  /** first video segment is the top rung, and the ladder is known to have more than one rung */
  isTopRung: boolean;
  ladderKnown: boolean;
  firstFrameMs?: number;
  /** all awaited downloads have finished */
  isComplete: boolean;
}

const earliest = (records: StartupRecord[], kind: string): StartupRecord | undefined =>
  records.filter((r) => r.kind === kind).reduce<StartupRecord | undefined>((a, r) => (!a || r.tRequest < a.tRequest ? r : a), undefined);

export const formatRendition = (r?: StartupRecord): string | undefined => {
  if (!r) {
    return undefined;
  }
  const kbps = r.bandwidthDeclared ? Math.round(r.bandwidthDeclared / 1000) + ' kbps' : undefined;
  return [r.resolution, kbps].filter(Boolean).join(' / ') || undefined;
};

const toRow = (key: string, label: string, r: StartupRecord, start: number): WaterfallRow => ({
  key,
  label,
  rendition: formatRendition(r),
  bytes: r.bytes,
  startMs: r.tRequest - start,
  firstByteMs: r.tFirstByte !== undefined ? r.tFirstByte - start : undefined,
  endMs: r.tLoaded !== undefined ? r.tLoaded - start : undefined,
  ttfbMs: r.tFirstByte !== undefined ? r.tFirstByte - r.tRequest : undefined,
  downloadMs: r.tLoaded !== undefined ? r.tLoaded - r.tRequest : undefined,
});

/** Top rung and whether the log has seen enough distinct rungs to call it. */
const topRung = (records: StartupRecord[], first?: StartupRecord, declaredRates: number[] = []): { isTop: boolean; known: boolean } => {
  const rates = declaredRates.length ? declaredRates : records
    .filter((r) => (r.kind === 'variant' || r.kind === 'video-segment' || r.kind === 'init') && r.bandwidthDeclared)
    .map((r) => r.bandwidthDeclared as number);
  const distinct = Array.from(new Set(rates));
  const known = distinct.length > 1;
  const top = Math.max(0, ...distinct);
  return { known, isTop: known && !!first && first.bandwidthDeclared === top };
};

const MAX_STEPS = 8;

export const computeStartup = (
  records: StartupRecord[],
  sessionStart?: number,
  firstFramePerf?: number,
  declaredRates: number[] = []
): StartupResult => {
  const master = earliest(records, 'master');
  const empty: StartupResult = { rows: [], isTopRung: false, ladderKnown: false, isComplete: false };
  const start = sessionStart ?? master?.tRequest;
  if (!master || start === undefined) {
    return empty;
  }
  const audioPlaylist = earliest(records, 'audio-playlist');
  const video = earliest(records, 'video-segment');
  const audio = earliest(records, 'audio-segment');
  const horizon = Math.max(video?.tLoaded ?? 0, audio?.tLoaded ?? 0) || Infinity;
  // Every variant playlist and init segment requested before startup finished, in order: an ABR switch before
  // the first segment (new playlist + new init) is often where the time goes, so it must be visible.
  const before = (kind: string) =>
    records.filter((r) => r.kind === kind && r.tRequest <= horizon).sort((a, b) => a.tRequest - b.tRequest);
  const steps = [...before('variant'), ...before('init')].sort((a, b) => a.tRequest - b.tRequest).slice(0, MAX_STEPS);

  const middle = [...steps, ...(audioPlaylist ? [audioPlaylist] : [])].sort((a, b) => a.tRequest - b.tRequest);
  let nVariant = 0;
  let nInit = 0;
  const rows: WaterfallRow[] = [
    toRow('master', 'master', master, start),
    ...middle.map((r) =>
      r.kind === 'audio-playlist'
        ? toRow('audio-playlist', 'audio playlist', r, start)
        : r.kind === 'init'
        ? toRow('init' + nInit++, 'init', r, start)
        : toRow('variant' + nVariant++, 'variant', r, start)
    ),
    ...(video ? [toRow('video', 'video seg', video, start)] : []),
    ...(audio ? [toRow('audio', 'audio seg', audio, start)] : []),
  ];

  const hasSeparateAudio = !!audioPlaylist || !!audio;
  const ends = [video?.tLoaded, hasSeparateAudio ? audio?.tLoaded : undefined];
  const isComplete = video?.tLoaded !== undefined && (!hasSeparateAudio || audio?.tLoaded !== undefined);
  const joinEnd = isComplete ? Math.max(...ends.filter((e): e is number => e !== undefined)) : undefined;
  const rung = topRung(records, video, declaredRates);

  return {
    rows,
    joinMs: joinEnd !== undefined ? joinEnd - master.tRequest : undefined,
    masterTtfbMs: master.tFirstByte !== undefined ? master.tFirstByte - master.tRequest : undefined,
    firstSegmentBytes: video?.bytes,
    firstSegmentRendition: formatRendition(video),
    startedOnRung: video?.resolution,
    isTopRung: rung.isTop,
    ladderKnown: rung.known,
    // a frame captured before this session's t0 belongs to an earlier load: not a first frame of this one
    firstFrameMs: firstFramePerf !== undefined && firstFramePerf >= start ? firstFramePerf - start : undefined,
    isComplete,
  };
};

const round = (n?: number): number | null => (n === undefined ? null : Math.round(n));

/** Plain object for "Copy as JSON". */
export const toJson = (r: StartupResult): object => ({
  joinMs: round(r.joinMs),
  masterTtfbMs: round(r.masterTtfbMs),
  firstSegmentBytes: r.firstSegmentBytes ?? null,
  firstSegmentRendition: r.firstSegmentRendition ?? null,
  startedOnRung: r.startedOnRung ?? null,
  startedOnTopRung: r.isTopRung,
  firstFrameMs: round(r.firstFrameMs),
  rows: r.rows.map((row) => ({
    name: row.label,
    rendition: row.rendition ?? null,
    bytes: row.bytes ?? null,
    startMs: round(row.startMs),
    ttfbMs: round(row.ttfbMs),
    downloadMs: round(row.downloadMs),
    endMs: round(row.endMs),
  })),
});

/** What the <video> is doing, as far as the first-frame milestone cares. */
export interface VideoSnapshot {
  hasVideo: boolean;
  paused: boolean;
  /** HTMLMediaElement.readyState */
  readyState: number;
  hasSource: boolean;
}

export type FirstFrameStatus = 'rendered' | 'no-video' | 'waiting-source' | 'buffering' | 'waiting-play';

/** Why the first frame is (not) there yet. Paused with data ready is the autoplay-blocked case. */
export const firstFrameStatus = (firstFrameMs: number | undefined, v: VideoSnapshot): FirstFrameStatus => {
  if (firstFrameMs !== undefined) {
    return 'rendered';
  }
  if (!v.hasVideo) {
    return 'no-video';
  }
  if (!v.hasSource) {
    return 'waiting-source';
  }
  // HAVE_CURRENT_DATA (2) or better and not playing: the browser is holding it until the user presses play
  return v.paused && v.readyState >= 2 ? 'waiting-play' : 'buffering';
};

const STATUS_TEXT: Record<FirstFrameStatus, string> = {
  rendered: '',
  'no-video': 'no video',
  'waiting-source': 'waiting for load',
  buffering: 'buffering',
  'waiting-play': 'waiting for play',
};

export const firstFrameText = (firstFrameMs: number | undefined, v: VideoSnapshot): string =>
  firstFrameMs !== undefined ? Math.round(firstFrameMs).toLocaleString() + ' ms' : STATUS_TEXT[firstFrameStatus(firstFrameMs, v)];
