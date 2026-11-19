// tslint:disable:max-line-length
/**
 * Pure inference for the "EdgeWorker" section of the Akamai edge panel: what did Peloton's manifest-personalization
 * EdgeWorkers (akamai-edgeworkers repo) most likely do to the master playlist THIS browser received.
 *
 * Sources: single-bitrate/ (?rendition=hd|sd|lb), radio-hls-personalization/ (radio_enabled, radio_playlist),
 * subtitle-hls-personalization/, media-token-fallback/, plus the x-pton-* / x-ew-failover header glossary from the
 * media-cloud akamai diagnostics notes. Anything not found there is reported as "unknown", never guessed.
 * No Angular imports and no token values are ever read or echoed.
 */
import { Headers, stripUrl } from './edge-view.logic';

export type EwConfidence = 'certain' | 'inferred' | 'unknown';
/** yes = sign found, no = looked and found none, unknown = cannot tell from what the browser can see. */
export type EwState = 'yes' | 'no' | 'unknown';

export interface EwFinding {
  id: 'ran' | 'single-rendition' | 'subtitles' | 'radio' | 'reroute-720p' | 'failover' | 'token';
  label: string;
  state: EwState;
  evidence: string;
  confidence: EwConfidence;
}

export interface EwRecordLike {
  kind: string;
  url: string;
  headers?: Headers;
  tRequest?: number;
}

export interface EwInput {
  /** Master playlist body as received (HLS.js only). Undefined when not captured. */
  masterText?: string;
  /** Request URL of the master playlist; falls back to the master record's URL. */
  requestUrl?: string;
  records: EwRecordLike[];
}

export interface MasterVariant {
  height?: number;
  bandwidth?: number;
  hasResolution: boolean;
}

export interface MasterMedia {
  type: string;
  name?: string;
  language?: string;
  uri?: string;
  isDefault: boolean;
}

export interface ParsedMaster {
  variants: MasterVariant[];
  iframeCount: number;
  media: MasterMedia[];
}

/** ?rendition= key to target RESOLUTION height (single-bitrate/constants.js). */
export const RENDITION_MAP: Record<string, number> = { hd: 1080, sd: 720, lb: 540 };
export const DEFAULT_RENDITION_HEIGHT = 720;
/** Names the radio EdgeWorker adds (radio-hls-personalization/src/manipulators.js). */
export const RADIO_ADDED_NAMES = ['Mixed', 'Music Boosted', 'Instructor Boosted'];
export const RADIO_KEPT_NAME = 'Instructor Only';
export const RADIO_MIXER_PATH = '/radio/api/v1/mixer/audio/playlist';
/** Subtitle localisation map values (subtitle-hls-personalization/src/constants.js): native name to English name. */
export const LOCALIZED_SUBTITLE_NAMES: Record<string, string> = { Español: 'Spanish', Français: 'French', Deutsche: 'German' };

export const UA_NOTE =
  'A browser cannot spoof its device User-Agent, so these results describe what this browser received, not what Roku, iOS or a home bike would get.';

const finding = (id: EwFinding['id'], label: string, state: EwState, confidence: EwConfidence, evidence: string): EwFinding => ({
  id,
  label,
  state,
  confidence,
  evidence,
});

/** Parses an HLS attribute list, honouring quoted values that contain commas. */
export const parseAttributes = (line: string): Record<string, string> => {
  const body = line.slice(line.indexOf(':') + 1);
  const attrs: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null = pattern.exec(body);
  while (m) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    m = pattern.exec(body);
  }
  return attrs;
};

export const parseMaster = (text: string): ParsedMaster => {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = lines
    .filter((l) => l.startsWith('#EXT-X-STREAM-INF'))
    .map((l) => {
      const a = parseAttributes(l);
      const res = /^\d+x(\d+)$/.exec(a.RESOLUTION || '');
      const bw = parseInt(a.BANDWIDTH, 10);
      return { height: res ? parseInt(res[1], 10) : undefined, bandwidth: isNaN(bw) ? undefined : bw, hasResolution: !!res };
    });
  const media = lines
    .filter((l) => l.startsWith('#EXT-X-MEDIA:'))
    .map((l) => {
      const a = parseAttributes(l);
      return { type: a.TYPE || '', name: a.NAME, language: a.LANGUAGE, uri: a.URI, isDefault: a.DEFAULT === 'YES' };
    });
  return { variants, iframeCount: lines.filter((l) => l.startsWith('#EXT-X-I-FRAME-STREAM-INF')).length, media };
};

/** Value of one query parameter, without decoding errors. Only the asked-for key is ever read. */
export const queryParam = (url: string | undefined, key: string): string | undefined => {
  if (!url) {
    return undefined;
  }
  const q = url.split('#')[0].split('?').slice(1).join('?');
  const hit = q.split('&').find((p) => p.split('=')[0] === key);
  if (hit === undefined) {
    return undefined;
  }
  const raw = hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch (e) {
    return raw;
  }
};

const header = (headers: Headers | undefined, name: string): string | undefined => (headers ? headers[name] : undefined);

const masterRecord = (records: EwRecordLike[]): EwRecordLike | undefined =>
  records.filter((r) => r.kind === 'master').sort((a, b) => (a.tRequest ?? 0) - (b.tRequest ?? 0))[0];

/** Parses "ok;sr=1;h=1080" into flags. */
export const parsePtonEw = (value?: string): { ok: boolean; sr?: boolean; height?: number } | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parts = value.split(';').map((p) => p.trim());
  const h = parts.find((p) => p.startsWith('h='));
  const sr = parts.find((p) => p.startsWith('sr='));
  return { ok: parts[0] === 'ok', sr: sr ? sr === 'sr=1' : undefined, height: h ? parseInt(h.slice(2), 10) || undefined : undefined };
};

const noMaster = (label: string, id: EwFinding['id']): EwFinding =>
  finding(id, label, 'unknown', 'unknown', 'Master playlist body was not captured (HLS.js only), so this cannot be checked.');

const inferRan = (hdrs: Headers | undefined): EwFinding => {
  const label = 'EdgeWorker ran on the master';
  const pton = header(hdrs, 'x-pton-ew');
  const bypass = header(hdrs, 'x-pton-ew-bypass');
  if (pton !== undefined) {
    return finding('ran', label, 'yes', 'certain', `x-pton-ew: ${pton}`);
  }
  if (bypass === 'skip') {
    return finding('ran', label, 'no', 'certain', 'x-pton-ew-bypass: skip (the Fingerprint Gate fired; the EdgeWorker did not run)');
  }
  if (header(hdrs, 'x-parent-applied') !== undefined) {
    return finding('ran', label, 'yes', 'certain', 'x-parent-applied present (legacy EdgeWorker build)');
  }
  return finding('ran', label, 'unknown', 'unknown', 'No x-pton-ew header readable. Either the EdgeWorker did not run, or the CDN does not expose the header to the browser.');
};

const inferSingleRendition = (parsed: ParsedMaster, url: string | undefined, hdrs: Headers | undefined): EwFinding => {
  const label = 'Ladder collapsed to a single variant';
  const key = (queryParam(url, 'rendition') || '').toLowerCase();
  const target = RENDITION_MAP[key];
  const keyText = key ? (target ? `rendition=${key} (${target}p)` : `rendition=${key} (unknown key, default ${DEFAULT_RENDITION_HEIGHT}p)`) : `no rendition key (default ${DEFAULT_RENDITION_HEIGHT}p)`;
  const withRes = parsed.variants.filter((v) => v.hasResolution);
  const pton = parsePtonEw(header(hdrs, 'x-pton-ew'));
  if (pton && pton.sr !== undefined) {
    return finding(
      'single-rendition',
      label,
      pton.sr ? 'yes' : 'no',
      'certain',
      `x-pton-ew reports sr=${pton.sr ? 1 : 0}${pton.height ? `, h=${pton.height}` : ''}; master lists ${parsed.variants.length} variant(s). Query: ${keyText}.`
    );
  }
  if (parsed.variants.length === 0) {
    return finding('single-rendition', label, 'unknown', 'unknown', 'No #EXT-X-STREAM-INF in the master (media playlist or audio-only).');
  }
  if (withRes.length === 0) {
    return finding('single-rendition', label, 'unknown', 'unknown', 'Variants carry no RESOLUTION, so the EdgeWorker (which maps by height) would pass them through unchanged.');
  }
  if (parsed.variants.length === 1) {
    const h = withRes[0].height as number;
    const fit = target ? (h === target ? `height ${h} equals the target` : `height ${h} differs from target ${target} (nearest-height pick, or ladder had no ${target})`) : `height ${h}`;
    return finding('single-rendition', label, 'yes', 'inferred', `Master lists 1 variant at ${h}p; ${fit}. Query: ${keyText}. A one-rung source ladder would look identical.`);
  }
  return finding(
    'single-rendition',
    label,
    'no',
    'inferred',
    `Master lists ${parsed.variants.length} variants (${Array.from(new Set(withRes.map((v) => v.height))).sort((a, b) => (b as number) - (a as number)).join('/')}p). Full ladder: EdgeWorker skipped, not matched, or not applied here (cause unknown).`
  );
};

const subtitleNames = (parsed: ParsedMaster): string[] => parsed.media.filter((m) => m.type === 'SUBTITLES').map((m) => m.name || m.language || '?');

const inferSubtitles = (parsed: ParsedMaster, url: string | undefined): EwFinding => {
  const label = 'Subtitles filtered or localised';
  const present = subtitleNames(parsed);
  const wanted = (queryParam(url, 'subtitle_name') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = present.length ? present.join(', ') : 'none';
  if (wanted.length === 0) {
    const localized = present.filter((n) => Object.keys(LOCALIZED_SUBTITLE_NAMES).map((k) => LOCALIZED_SUBTITLE_NAMES[k]).includes(n));
    const native = present.filter((n) => Object.keys(LOCALIZED_SUBTITLE_NAMES).includes(n));
    if (localized.length > 0 && native.length === 0) {
      return finding('subtitles', label, 'unknown', 'inferred', `No subtitle_name in the query. Present: ${list}. English-language names (Spanish/French/German) match the localisation map, but could also be the source names.`);
    }
    return finding('subtitles', label, 'unknown', 'unknown', `No subtitle_name in the query, so no filter was requested. Present: ${list}. The expected full set is not knowable from the browser.`);
  }
  const lower = present.map((n) => n.toLowerCase());
  const wantedLower = wanted.map((n) => n.toLowerCase());
  const missingWanted = wanted.filter((n) => !lower.includes(n.toLowerCase()));
  const extra = present.filter((n) => !wantedLower.includes(n.toLowerCase()));
  if (present.length === 0) {
    return finding('subtitles', label, 'unknown', 'unknown', `subtitle_name=${wanted.join(',')} requested, but the master has no subtitle tracks.`);
  }
  if (extra.length === 0) {
    return finding('subtitles', label, 'yes', 'inferred', `subtitle_name=${wanted.join(',')} requested; only ${list} remain${missingWanted.length ? ` (requested but absent: ${missingWanted.join(', ')})` : ''}. Source set before filtering is unknown.`);
  }
  return finding('subtitles', label, 'no', 'inferred', `subtitle_name=${wanted.join(',')} requested but extra tracks remain: ${extra.join(', ')}. The filter keeps the original set when nothing matches.`);
};

const inferRadio = (parsed: ParsedMaster, url: string | undefined): EwFinding => {
  const label = 'Radio / instructor playlist rewritten';
  const enabled = queryParam(url, 'radio_enabled');
  const playlist = queryParam(url, 'radio_playlist');
  const audio = parsed.media.filter((m) => m.type === 'AUDIO');
  const names = audio.map((m) => m.name);
  const addedFound = RADIO_ADDED_NAMES.filter((n) => names.includes(n));
  const mixer = audio.find((m) => !!m.uri && m.uri.includes(RADIO_MIXER_PATH));
  const query = `radio_enabled=${enabled ? 'set' : 'absent'}, radio_playlist=${playlist ? 'set' : 'absent'}`;
  if (mixer) {
    return finding('radio', label, 'yes', 'certain', `AUDIO track "${mixer.name}" points at ${RADIO_MIXER_PATH}; added tracks present: ${addedFound.join(', ') || 'none'}. Query: ${query}.`);
  }
  if (addedFound.length === RADIO_ADDED_NAMES.length) {
    return finding('radio', label, 'yes', 'inferred', `AUDIO tracks ${addedFound.join(', ')} match the names the radio EdgeWorker adds, but no mixer URI was seen. Query: ${query}.`);
  }
  if (enabled && audio.length === 1 && audio[0].name === RADIO_KEPT_NAME) {
    return finding('radio', label, 'yes', 'inferred', `radio_enabled set and the only AUDIO track is "${RADIO_KEPT_NAME}" (the filter keeps only that name). Query: ${query}.`);
  }
  if (enabled) {
    return finding('radio', label, 'no', 'inferred', `radio_enabled set but audio is ${names.join(', ') || 'absent'}; the filter returns the original audio when "${RADIO_KEPT_NAME}" is missing. Query: ${query}.`);
  }
  return finding('radio', label, 'no', 'inferred', `No radio_enabled in the query and no radio tracks (audio: ${names.join(', ') || 'none'}).`);
};

const inferReroute = (url: string | undefined, hdrs: Headers | undefined): EwFinding => {
  const label = '_720p reroute';
  const label2 = 'x-pton-ew-bypass';
  const bypass = header(hdrs, 'x-pton-ew-bypass');
  if (bypass === '720') {
    return finding('reroute-720p', label, 'yes', 'certain', `${label2}: 720 (the _720p reroute or redirect served this)`);
  }
  if (bypass === 'skip') {
    return finding('reroute-720p', label, 'yes', 'certain', `${label2}: skip (gate fired; the property answers with a 302 to the *_720p manifest)`);
  }
  const path = url ? stripUrl(url) : '';
  if (/_720p\.m3u8$/i.test(path)) {
    return finding('reroute-720p', label, 'yes', 'inferred', `Master path ends in _720p.m3u8 (${path}); the property reroutes <name>.m3u8 to <name>_720p.m3u8, but the player may also have been given that URL directly.`);
  }
  return finding('reroute-720p', label, 'no', 'inferred', 'Master path is not a _720p manifest and no x-pton-ew-bypass header was readable.');
};

const inferFailover = (hdrs: Headers | undefined, records: EwRecordLike[]): EwFinding => {
  const label = 'Failover';
  const attempt = [hdrs, ...records.filter((r) => r.kind !== 'master').map((r) => r.headers)].map((h) => header(h, 'x-ew-failover')).find((v) => v !== undefined);
  if (attempt !== undefined) {
    return finding('failover', label, 'yes', 'certain', `x-ew-failover: ${attempt}`);
  }
  const server = (header(hdrs, 'server') || '').toLowerCase();
  const via = (header(hdrs, 'via') || '').toLowerCase();
  const cache = (header(hdrs, 'x-cache') || '').toLowerCase();
  if (/cloudfront|amazons3/.test(server) || /cloudfront/.test(via) || /cloudfront/.test(cache)) {
    return finding('failover', label, 'yes', 'inferred', `Response came from ${server ? `server: ${server}` : via ? `via: ${via}` : `x-cache: ${cache}`}, the CloudFront failover origin. Personalisation query params are ignored there.`);
  }
  if (hdrs && (hdrs.server !== undefined || hdrs['x-cache'] !== undefined || hdrs.via !== undefined)) {
    return finding('failover', label, 'no', 'inferred', 'Readable server/x-cache headers do not point at CloudFront.');
  }
  return finding('failover', label, 'unknown', 'unknown', 'No x-ew-failover, server, via or x-cache header readable on the master, so failover cannot be ruled in or out.');
};

const inferToken = (url: string | undefined): EwFinding => {
  const label = 'Token fallback';
  const base = 'The media-token-fallback EdgeWorker only mints an hdnts token on a JSON endpoint; it does not rewrite manifests, so a fallback cannot be seen in one.';
  if (!url) {
    return finding('token', label, 'unknown', 'unknown', base);
  }
  const kind = /[?&]hdnts=/.test(url) ? 'hdnts in the query' : /[?&]hdntl=|\/hdntl=/.test(url) ? 'hdntl' : /\/hdnts=/.test(url) ? 'hdnts in the path' : 'no hdnts/hdntl token';
  return finding('token', label, 'unknown', 'unknown', `${base} Master URL carries: ${kind} (value never shown).`);
};

/** All EdgeWorker findings for the master playlist this browser received. */
export const inferEdgeWorker = (input: EwInput): EwFinding[] => {
  const master = masterRecord(input.records);
  const url = input.requestUrl || (master ? master.url : undefined);
  const hdrs = master ? master.headers : undefined;
  const ran = inferRan(hdrs);
  const reroute = inferReroute(url, hdrs);
  const failover = inferFailover(hdrs, input.records);
  const token = inferToken(url);
  if (!input.masterText) {
    return [
      ran,
      noMaster('Ladder collapsed to a single variant', 'single-rendition'),
      noMaster('Subtitles filtered or localised', 'subtitles'),
      noMaster('Radio / instructor playlist rewritten', 'radio'),
      reroute,
      failover,
      token,
    ];
  }
  const parsed = parseMaster(input.masterText);
  return [ran, inferSingleRendition(parsed, url, hdrs), inferSubtitles(parsed, url), inferRadio(parsed, url), reroute, failover, token];
};
