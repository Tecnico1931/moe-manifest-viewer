/**
 * Pure logic for the Akamai edge panel: header parsing, cache classification, Server-Timing parsing,
 * URL sanitising and summary KPIs. No Angular imports so it can be tested with ts-node.
 */

export type Headers = Record<string, string>;
export type CacheResult = 'hit' | 'miss' | 'unknown';
export type CacheSource = 'akamai-cache-status' | 'x-cache' | 'server-timing' | 'none';

/** Minimal shape of RequestRecord used here (kept structural so this file has no imports). */
export interface EdgeRecordLike {
  id: number;
  url: string;
  kind: string;
  status?: number;
  tRequest: number;
  tFirstByte?: number;
  tLoaded?: number;
  bytes?: number;
  level?: number;
  headers?: Headers;
}

export interface ServerTimingEntry {
  name: string;
  dur?: number;
  desc?: string;
}

export interface CacheInfo {
  result: CacheResult;
  /** Raw token that decided it, e.g. TCP_MEM_HIT, "Hit from child", HIT. */
  label: string;
  source: CacheSource;
}

export interface EdgeRow {
  id: number;
  kind: string;
  /** host + path, no query, no token path segments. */
  path: string;
  status?: number;
  cache: CacheInfo;
  remoteCache?: string;
  servedBy?: string;
  /** "name: value" entries for EdgeWorker debug headers and x-pton-* headers. */
  edgeWorker: string[];
  hasEdgeWorker: boolean;
  age?: number;
  contentLength?: number;
  ttfbMs?: number;
  downloadMs?: number;
  edgeDurMs?: number;
  originDurMs?: number;
  /** Everything else parsed, for the detail view. Query is stripped from the cache key. */
  details: Array<[string, string]>;
}

export interface EdgeSummary {
  segments: number;
  classifiedSegments: number;
  hits: number;
  misses: number;
  hitRatio?: number;
  medianTtfbHitMs?: number;
  medianTtfbMissMs?: number;
  medianEdgeDurMs?: number;
  medianOriginDurMs?: number;
  edgeWorkerSeen: boolean;
}

export interface HeaderVisibility {
  name: string;
  /** 'debug' headers only come back when the Akamai Pragma request header is sent. */
  needs: 'debug' | 'property';
  seen: boolean;
}

export const PINNED_KINDS = ['master', 'variant', 'audio-playlist', 'subtitle-playlist'];
export const SEGMENT_KINDS = ['video-segment', 'audio-segment', 'subtitle-segment'];

export const EW_DEBUG_PREFIXES = ['x-akamai-edgeworker-', 'akamai-x-ew-', 'x-akamai-ew-'];
export const PTON_PREFIX = 'x-pton-';

/** Headers we look for. 'debug' ones need the Pragma request header; 'property' ones are sent by the property config. */
export const TRACKED_HEADERS: Array<{ name: string; needs: 'debug' | 'property' }> = [
  { name: 'x-cache', needs: 'debug' },
  { name: 'x-cache-remote', needs: 'debug' },
  { name: 'x-check-cacheable', needs: 'debug' },
  { name: 'x-cache-key', needs: 'debug' },
  { name: 'x-akamai-request-id', needs: 'debug' },
  { name: 'x-serial', needs: 'debug' },
  { name: 'akamai-cache-status', needs: 'property' },
  { name: 'akamai-grn', needs: 'property' },
  { name: 'server-timing', needs: 'property' },
  { name: 'age', needs: 'property' },
  { name: 'cache-control', needs: 'property' },
  { name: 'expires', needs: 'property' },
  { name: 'via', needs: 'property' },
  { name: 'server', needs: 'property' },
];

/** Concrete names for Access-Control-Expose-Headers (the header does not accept wildcards for credentialed requests, so list them). */
export const EXPOSE_HEADERS_VALUE = [
  'x-cache',
  'x-cache-remote',
  'x-cache-key',
  'x-check-cacheable',
  'x-serial',
  'x-akamai-request-id',
  'akamai-cache-status',
  'akamai-grn',
  'server-timing',
  'via',
  'server',
  'x-pton-ew',
].join(', ');

export const PRAGMA_VALUE = [
  'akamai-x-cache-on',
  'akamai-x-cache-remote-on',
  'akamai-x-check-cacheable',
  'akamai-x-get-cache-key',
  'akamai-x-get-request-id',
  'akamai-x-get-true-cache-key',
  'akamai-x-serial-no',
].join(', ');

const TOKEN_PATH_SEGMENT = /^(hdntl|hdnts|hdnea|hdcore|token|hmac|__gda__|exp)=/i;

/**
 * Replaces token-bearing path segments (hdntl=..., hdnts=...) with {token}. A token whose acl contains slashes
 * (acl=/classes/*~hmac=...) spans several segments: everything up to the one holding hmac= is swallowed.
 */
const redactTokenSegments = (path: string): string => {
  const out: string[] = [];
  let swallowing = false;
  path.split('/').forEach((seg) => {
    if (swallowing) {
      swallowing = !/hmac=/i.test(seg);
      return;
    }
    if (TOKEN_PATH_SEGMENT.test(seg)) {
      swallowing = !/hmac=/i.test(seg) && /^(hdntl|hdnts|hdnea)=/i.test(seg);
      out.push('{token}');
      return;
    }
    out.push(seg);
  });
  return out.join('/');
};

/** host + path with the query, fragment and any token-bearing path segments (hdntl=..., hdnts=...) removed. */
export const stripUrl = (url: string): string => {
  if (!url) {
    return '';
  }
  const noQuery = url.split(/[?#]/)[0];
  const match = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/]*)(\/.*)?$/i.exec(noQuery);
  const host = match ? match[1] : '';
  const path = match ? match[2] || '/' : noQuery;
  return host + redactTokenSegments(path);
};

/** x-cache-key looks like "/L/1234/5678/1d/host/path/file.m3u8?query": drop the query and token segments. */
export const sanitizeCacheKey = (key: string): string => redactTokenSegments(key.split('?')[0]);

export const parseServerTiming = (value?: string): ServerTimingEntry[] =>
  (value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [name, ...params] = part.split(';').map((p) => p.trim());
      const get = (key: string): string | undefined => {
        const param = params.find((p) => p.toLowerCase().startsWith(key + '='));
        return param ? param.slice(key.length + 1).replace(/^"|"$/g, '') : undefined;
      };
      const dur = get('dur');
      const parsed = dur !== undefined ? Number(dur) : undefined;
      return { name: name.toLowerCase(), dur: parsed !== undefined && isFinite(parsed) ? parsed : undefined, desc: get('desc') };
    })
    .filter((entry) => entry.name.length > 0);

const classifyToken = (token: string): CacheResult => {
  const t = token.toLowerCase();
  if (/miss/.test(t)) {
    return 'miss';
  }
  if (/hit|refresh|revalid|ims/.test(t)) {
    return 'hit';
  }
  return 'unknown';
};

/** "TCP_MEM_HIT from a23-1-2-3.deploy.akamaitechnology.com (AkamaiGHost/11.1) (-)" -> TCP_MEM_HIT */
export const parseXCache = (value?: string): { token?: string; edge?: string } => {
  if (!value) {
    return {};
  }
  const token = /^\s*([A-Za-z_]+)/.exec(value)?.[1];
  const edge = /\bfrom\s+(\S+)/i.exec(value)?.[1];
  return { token, edge };
};

/**
 * Cache classification, most specific source first: akamai-cache-status, x-cache, server-timing cdn-cache.
 * akamai-cache-status "Miss from child, Hit from parent" counts as a hit: the origin was not contacted.
 */
export const classifyCache = (headers: Headers = {}): CacheInfo => {
  const status = headers['akamai-cache-status'];
  if (status) {
    const parts = status.split(',').map((p) => p.trim());
    const hitPart = parts.find((p) => /^hit/i.test(p) || /^refresh/i.test(p));
    const result: CacheResult = hitPart ? 'hit' : parts.some((p) => /^miss/i.test(p)) ? 'miss' : 'unknown';
    if (result !== 'unknown') {
      return { result, label: hitPart || parts[0], source: 'akamai-cache-status' };
    }
  }
  const xc = parseXCache(headers['x-cache']);
  if (xc.token && classifyToken(xc.token) !== 'unknown') {
    return { result: classifyToken(xc.token), label: xc.token, source: 'x-cache' };
  }
  const cdn = parseServerTiming(headers['server-timing']).find((e) => e.name === 'cdn-cache');
  if (cdn?.desc && classifyToken(cdn.desc) !== 'unknown') {
    return { result: classifyToken(cdn.desc), label: cdn.desc.toUpperCase(), source: 'server-timing' };
  }
  return { result: 'unknown', label: '', source: 'none' };
};

const isEwDebug = (name: string): boolean => EW_DEBUG_PREFIXES.some((p) => name.startsWith(p));

/** EdgeWorker debug headers and every x-pton-* header, shown raw. */
export const edgeWorkerEntries = (headers: Headers = {}): string[] =>
  Object.keys(headers)
    .filter((name) => isEwDebug(name) || name.startsWith(PTON_PREFIX))
    .sort()
    .map((name) => `${name}: ${headers[name]}`);

export const hasPtonHeader = (headers: Headers = {}): boolean => Object.keys(headers).some((n) => n.startsWith(PTON_PREFIX));

const toNumber = (value?: string): number | undefined => {
  const n = value !== undefined && value !== '' ? Number(value) : NaN;
  return isFinite(n) ? n : undefined;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

export const median = (values: number[]): number | undefined => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const defined = (values: Array<number | undefined>): number[] => values.filter((v): v is number => v !== undefined);

export const buildRow = (record: EdgeRecordLike): EdgeRow => {
  const h = record.headers || {};
  const timing = parseServerTiming(h['server-timing']);
  const durOf = (name: string) => timing.find((e) => e.name === name)?.dur;
  const xc = parseXCache(h['x-cache']);
  const ttfb = record.tFirstByte !== undefined ? record.tFirstByte - record.tRequest : undefined;
  const download = record.tLoaded !== undefined && record.tFirstByte !== undefined ? record.tLoaded - record.tFirstByte : undefined;
  const edgeWorker = edgeWorkerEntries(h);
  const details: Array<[string, string]> = [];
  const add = (label: string, value?: string) => value && details.push([label, value]);
  add('x-cache', h['x-cache']);
  add('x-cache-remote', h['x-cache-remote']);
  add('x-check-cacheable', h['x-check-cacheable']);
  add('x-cache-key', h['x-cache-key'] ? sanitizeCacheKey(h['x-cache-key']) : undefined);
  add('x-akamai-request-id', h['x-akamai-request-id']);
  add('x-serial', h['x-serial']);
  add('akamai-cache-status', h['akamai-cache-status']);
  add('akamai-grn', h['akamai-grn']);
  add('server-timing', h['server-timing']);
  add('age', h['age']);
  add('cache-control', h['cache-control']);
  add('expires', h['expires']);
  add('via', h['via']);
  add('server', h['server']);
  Object.keys(h)
    .filter((n) => n.startsWith('cmcd-'))
    .sort()
    .forEach((n) => add(n, h[n]));
  return {
    id: record.id,
    kind: record.kind,
    path: stripUrl(record.url),
    status: record.status,
    cache: classifyCache(h),
    remoteCache: h['x-cache-remote'] ? parseXCache(h['x-cache-remote']).token : undefined,
    servedBy: xc.edge || h['server'],
    edgeWorker,
    hasEdgeWorker: edgeWorker.length > 0,
    age: toNumber(h['age']),
    contentLength: toNumber(h['content-length']) ?? record.bytes,
    ttfbMs: ttfb !== undefined ? round1(ttfb) : undefined,
    downloadMs: download !== undefined ? round1(download) : undefined,
    edgeDurMs: durOf('edge'),
    originDurMs: durOf('origin'),
    details,
  };
};

/** Master and variant playlists pinned first (stable order), then everything else by request order. */
export const orderRows = (rows: EdgeRow[]): EdgeRow[] => {
  const pinned = rows.filter((r) => PINNED_KINDS.includes(r.kind));
  const rest = rows.filter((r) => !PINNED_KINDS.includes(r.kind));
  const rank = (r: EdgeRow) => PINNED_KINDS.indexOf(r.kind);
  return [...pinned.sort((a, b) => rank(a) - rank(b) || a.id - b.id), ...rest.sort((a, b) => a.id - b.id)];
};

export const filterRows = (rows: EdgeRow[], kind: string): EdgeRow[] => (kind === 'all' ? rows : rows.filter((r) => r.kind === kind));

export const summarize = (rows: EdgeRow[]): EdgeSummary => {
  const segments = rows.filter((r) => SEGMENT_KINDS.includes(r.kind));
  const hits = segments.filter((r) => r.cache.result === 'hit');
  const misses = segments.filter((r) => r.cache.result === 'miss');
  const classified = hits.length + misses.length;
  return {
    segments: segments.length,
    classifiedSegments: classified,
    hits: hits.length,
    misses: misses.length,
    hitRatio: classified > 0 ? hits.length / classified : undefined,
    medianTtfbHitMs: median(defined(hits.map((r) => r.ttfbMs))),
    medianTtfbMissMs: median(defined(misses.map((r) => r.ttfbMs))),
    medianEdgeDurMs: median(defined(rows.map((r) => r.edgeDurMs))),
    medianOriginDurMs: median(defined(rows.map((r) => r.originDurMs))),
    edgeWorkerSeen: rows.some((r) => r.hasEdgeWorker),
  };
};

const EW_NAME_HINT = /_720p|_stable|_sbr|_single|single[-_]?bitrate/i;

export interface SingleBitrateInput {
  records: EdgeRecordLike[];
  /** Variants declared in the master playlist, when known. Otherwise the observed video levels are used. */
  declaredVideoVariants?: number;
}

export interface SingleBitrateResult {
  isSingle: boolean;
  /** Why the chip is (or is not) shown. */
  reason: string;
}

/**
 * Single-bitrate rendition served: exactly one video variant AND a hint of an EdgeWorker variant
 * (name like _720p/_stable in a manifest path, or an x-pton-* header on a playlist response).
 */
export const detectSingleBitrate = ({ records, declaredVideoVariants }: SingleBitrateInput): SingleBitrateResult => {
  const master = records.find((r) => r.kind === 'master');
  if (!master) {
    return { isSingle: false, reason: 'no master playlist seen' };
  }
  const isVideoKind = (kind: string) => ['variant', 'video-segment', 'init'].includes(kind);
  const videoLevels = new Set(records.filter((r) => isVideoKind(r.kind) && r.level !== undefined).map((r) => r.level));
  const variantUrls = new Set(records.filter((r) => r.kind === 'variant').map((r) => stripUrl(r.url)));
  const videoSegments = records.filter((r) => r.kind === 'video-segment').length;
  const count = declaredVideoVariants ?? (videoSegments >= 2 ? Math.max(videoLevels.size, variantUrls.size) : undefined);
  if (count !== 1) {
    return { isSingle: false, reason: count === undefined ? 'ladder size unknown' : `${count} video variants` };
  }
  const playlists = records.filter((r) => ['master', 'variant'].includes(r.kind));
  const nameHint = playlists.some((r) => EW_NAME_HINT.test(stripUrl(r.url)));
  const headerHint = playlists.some((r) => hasPtonHeader(r.headers));
  if (!nameHint && !headerHint) {
    return { isSingle: false, reason: 'one variant but no EdgeWorker hint' };
  }
  return { isSingle: true, reason: nameHint ? 'one variant, EdgeWorker-style manifest name' : 'one variant, x-pton header on playlist' };
};

/** Which tracked headers were readable on at least one request. Prefix families (x-pton-*, EdgeWorker debug) included. */
export const headerVisibility = (records: Array<{ headers?: Headers }>): HeaderVisibility[] => {
  const names = new Set<string>();
  records.forEach((r) => Object.keys(r.headers || {}).forEach((n) => names.add(n)));
  const base = TRACKED_HEADERS.map((t) => ({ ...t, seen: names.has(t.name) }));
  const anyPrefix = (prefixes: string[]) => Array.from(names).some((n) => prefixes.some((p) => n.startsWith(p)));
  return [
    ...base,
    { name: 'x-pton-*', needs: 'property' as const, seen: anyPrefix([PTON_PREFIX]) },
    { name: 'x-akamai-edgeworker-* / akamai-x-ew-*', needs: 'debug' as const, seen: anyPrefix(EW_DEBUG_PREFIXES) },
  ];
};

export const formatBytes = (n?: number): string => {
  if (n === undefined) {
    return '';
  }
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
};
