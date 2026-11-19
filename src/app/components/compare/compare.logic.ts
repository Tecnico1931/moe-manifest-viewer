/** Pure logic for the A/B ladder compare panel: master parsing, alignment by height, deltas and totals. */

export interface CmpRung {
  width: number;
  height: number;
  /** BANDWIDTH, bps */
  bandwidth: number;
  /** AVERAGE-BANDWIDTH, bps */
  avg?: number;
  codecs?: string;
  fps?: number;
  audioGroup?: string;
  /** Variant playlist URI exactly as written in the master. */
  uri?: string;
}

export interface CmpAudioGroup {
  groupId: string;
  names: string[];
  channels: string[];
}

export interface CmpLadder {
  rungs: CmpRung[];
  audio: CmpAudioGroup[];
}

export interface CmpRow {
  height: number;
  a?: CmpRung;
  b?: CmpRung;
  /** (B - A) / A in percent; undefined when either side or its value is missing. */
  deltaBandwidthPct?: number;
  deltaAvgPct?: number;
}

export interface CmpTotals {
  count: number;
  sumAvg: number;
  sumBandwidth: number;
  /** Rungs with no AVERAGE-BANDWIDTH, so the sum is a lower bound. */
  missingAvg: number;
}

export interface Segment {
  url: string;
  duration: number;
}

const attr = (line: string, name: string): string | undefined => {
  const m = new RegExp('(?:^|[:,])' + name + '=("[^"]*"|[^,]*)').exec(line);
  return m ? m[1].replace(/^"|"$/g, '') : undefined;
};

const parseRes = (res?: string): { width: number; height: number } | undefined => {
  const m = /^(\d+)x(\d+)$/i.exec((res || '').trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
};

/** Parses video variants (EXT-X-STREAM-INF, I-frame playlists ignored) and audio groups (EXT-X-MEDIA TYPE=AUDIO). */
export const parseMaster = (text: string): CmpLadder => {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const rungs: CmpRung[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) {
      return;
    }
    const res = parseRes(attr(line, 'RESOLUTION'));
    const bandwidth = Number(attr(line, 'BANDWIDTH')) || 0;
    if (!res || !bandwidth) {
      return;
    }
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    rungs.push({
      ...res,
      bandwidth,
      avg: Number(attr(line, 'AVERAGE-BANDWIDTH')) || undefined,
      codecs: attr(line, 'CODECS'),
      fps: Number(attr(line, 'FRAME-RATE')) || undefined,
      audioGroup: attr(line, 'AUDIO'),
      uri,
    });
  });
  const groups = new Map<string, CmpAudioGroup>();
  lines
    .filter((l) => l.startsWith('#EXT-X-MEDIA:') && attr(l, 'TYPE') === 'AUDIO')
    .forEach((l) => {
      const groupId = attr(l, 'GROUP-ID') || '';
      const g = groups.get(groupId) || { groupId, names: [], channels: [] };
      const name = attr(l, 'NAME') || attr(l, 'LANGUAGE');
      const ch = attr(l, 'CHANNELS');
      groups.set(groupId, {
        groupId,
        names: name && g.names.indexOf(name) < 0 ? [...g.names, name] : g.names,
        channels: ch && g.channels.indexOf(ch) < 0 ? [...g.channels, ch] : g.channels,
      });
    });
  return { rungs: rungs.sort((x, y) => x.height - y.height || x.bandwidth - y.bandwidth), audio: Array.from(groups.values()) };
};

export const deltaPct = (a?: number, b?: number): number | undefined => (a && b !== undefined ? ((b - a) / a) * 100 : undefined);

/** Aligns two ladders by height (ascending). Rungs sharing a height are paired in bitrate order. */
export const alignByHeight = (a: CmpRung[], b: CmpRung[]): CmpRow[] => {
  const heights = Array.from(new Set([...a, ...b].map((r) => r.height))).sort((x, y) => x - y);
  const at = (rungs: CmpRung[], h: number) => rungs.filter((r) => r.height === h).sort((x, y) => x.bandwidth - y.bandwidth);
  return heights.reduce<CmpRow[]>((rows, height) => {
    const as = at(a, height);
    const bs = at(b, height);
    const n = Math.max(as.length, bs.length);
    const added = Array.from({ length: n }, (_, i) => {
      const ra = as[i];
      const rb = bs[i];
      return {
        height,
        a: ra,
        b: rb,
        deltaBandwidthPct: ra && rb ? deltaPct(ra.bandwidth, rb.bandwidth) : undefined,
        deltaAvgPct: ra && rb ? deltaPct(ra.avg, rb.avg) : undefined,
      } as CmpRow;
    });
    return [...rows, ...added];
  }, []);
};

export const totals = (rungs: CmpRung[]): CmpTotals => ({
  count: rungs.length,
  sumAvg: rungs.reduce((s, r) => s + (r.avg || 0), 0),
  sumBandwidth: rungs.reduce((s, r) => s + r.bandwidth, 0),
  missingAvg: rungs.filter((r) => !r.avg).length,
});

export const audioSummary = (groups: CmpAudioGroup[]): string =>
  groups.length
    ? groups.map((g) => `${g.groupId}: ${g.names.join(', ') || '—'}${g.channels.length ? ' (' + g.channels.join('/') + 'ch)' : ''}`).join('; ')
    : 'none (muxed or not declared)';

/** Finds the delivered average (kbps) for an A rung from bitrate-audit rows, matching resolution and declared BANDWIDTH. */
export const deliveredKbps = (
  rung: CmpRung | undefined,
  rows: { resolution?: string; bandwidthKbps?: number; avgKbps?: number; combinedAvgKbps?: number }[]
): number | undefined => {
  if (!rung) {
    return undefined;
  }
  const row = rows.find(
    (r) => r.resolution === `${rung.width}x${rung.height}` && Math.abs((r.bandwidthKbps ?? -1e9) - rung.bandwidth / 1000) < 1
  );
  return row ? row.combinedAvgKbps ?? row.avgKbps : undefined;
};

/** Resolves a playlist URI against its parent and carries the parent's query string over when the URI has none. */
export const resolveUri = (uri: string, parentUrl: string): string => {
  const resolved = new URL(uri, parentUrl);
  if (!resolved.search && !/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    resolved.search = new URL(parentUrl).search;
  }
  return resolved.href;
};

/** First `max` segments of a media playlist with durations. */
export const firstSegments = (text: string, playlistUrl: string, max: number): Segment[] => {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: Segment[] = [];
  let duration = 0;
  for (const line of lines) {
    if (out.length >= max) {
      break;
    }
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line && !line.startsWith('#')) {
      out.push({ url: resolveUri(line, playlistUrl), duration });
      duration = 0;
    }
  }
  return out;
};

/** Delivered bitrate in kbps from byte counts and durations; undefined without a duration. */
export const measuredKbps = (bytes: number[], durations: number[]): number | undefined => {
  const secs = durations.reduce((s, d) => s + d, 0);
  return secs > 0 ? (bytes.reduce((s, n) => s + n, 0) * 8) / secs / 1000 : undefined;
};
