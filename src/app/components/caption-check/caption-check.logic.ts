/** Pure helpers for the Captions panel: master-playlist media checks and WebVTT cue analysis. */
import { parseAttributes, resolveUrl } from '../audio-compare/audio-compare.logic';

export type MediaType = 'SUBTITLES' | 'CLOSED-CAPTIONS' | 'AUDIO';
export type Severity = 'error' | 'warn' | 'info';

export interface MediaEntry {
  type: string;
  groupId: string;
  name: string;
  language?: string;
  isDefault: boolean;
  isAutoselect: boolean;
  isForced: boolean;
  channels?: string;
  instreamId?: string;
  uri?: string;
}

export interface VariantRef {
  bandwidth?: number;
  codecs: string[];
  audio?: string;
  subtitles?: string;
  closedCaptions?: string;
}

export interface MasterMedia {
  media: MediaEntry[];
  variants: VariantRef[];
}

export interface Issue {
  severity: Severity;
  message: string;
}

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

export interface VttFile {
  isWebVtt: boolean;
  cues: Cue[];
  timestampMap?: { mpegts: number; local: number };
}

export const GAP_SEC = 10;
export const LONG_CUE_SEC = 7;
export const MAX_LINE_CHARS = 42;
export const MAX_SEGMENTS = 40;

const yes = (v: string | undefined): boolean => (v || '').toUpperCase() === 'YES';

/* ------------------------------- master playlist ------------------------------- */

export const parseMasterMedia = (text: string, baseUrl: string): MasterMedia => {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const media: MediaEntry[] = lines
    .filter((l) => l.startsWith('#EXT-X-MEDIA:'))
    .map((l) => parseAttributes(l.slice('#EXT-X-MEDIA:'.length)))
    .map((a) => ({
      type: (a.TYPE || '').toUpperCase(),
      groupId: a['GROUP-ID'] || '',
      name: a.NAME || '',
      language: a.LANGUAGE || undefined,
      isDefault: yes(a.DEFAULT),
      isAutoselect: yes(a.AUTOSELECT),
      isForced: yes(a.FORCED),
      channels: a.CHANNELS || undefined,
      instreamId: a['INSTREAM-ID'] || undefined,
      uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
    }));
  const variants: VariantRef[] = lines
    .filter((l) => l.startsWith('#EXT-X-STREAM-INF:'))
    .map((l) => parseAttributes(l.slice('#EXT-X-STREAM-INF:'.length)))
    .map((a) => ({
      bandwidth: a.BANDWIDTH ? parseInt(a.BANDWIDTH, 10) : undefined,
      codecs: (a.CODECS || '')
        .split(',')
        .map((c) => c.trim())
        .filter((c) => !!c),
      audio: a.AUDIO,
      subtitles: a.SUBTITLES,
      closedCaptions: a['CLOSED-CAPTIONS'],
    }));
  return { media, variants };
};

const isAudioCodec = (c: string): boolean => /^(mp4a|ec-3|ac-3|ac-4|opus|flac|alac|mha1|mhm1|dtsc|dtse|dtsh|dtsl)/i.test(c);

/** Audio codecs advertised by the variants that reference `groupId`. */
export const audioCodecsForGroup = (variants: VariantRef[], groupId: string): string[] =>
  variants
    .filter((v) => v.audio === groupId)
    .reduce<string[]>((acc, v) => [...acc, ...v.codecs.filter(isAudioCodec)], [])
    .filter((c, i, all) => all.indexOf(c) === i);

const keyOf = (m: MediaEntry): string => `${m.type}/${m.groupId}`;

/** Master-level checks for SUBTITLES / CLOSED-CAPTIONS (and the variant group references). */
export const checkCaptionMedia = (master: MasterMedia): Issue[] => {
  const issues: Issue[] = [];
  const caps = master.media.filter((m) => m.type === 'SUBTITLES' || m.type === 'CLOSED-CAPTIONS');
  const groups = caps.map(keyOf).filter((k, i, all) => all.indexOf(k) === i);
  groups.forEach((group) => {
    const members = caps.filter((m) => keyOf(m) === group);
    members.filter((m) => !m.language).forEach((m) => issues.push({ severity: 'error', message: `${group}: "${m.name}" has no LANGUAGE` }));
    const seen: Record<string, number> = {};
    members
      .filter((m) => !!m.language)
      .forEach((m) => {
        const k = `${(m.language as string).toLowerCase()}|${m.isForced}`;
        seen[k] = (seen[k] || 0) + 1;
      });
    Object.keys(seen)
      .filter((k) => seen[k] > 1)
      .forEach((k) => {
        const [lang, forced] = k.split('|');
        issues.push({
          severity: 'warn',
          message: `${group}: language "${lang}"${forced === 'true' ? ' (forced)' : ''} appears ${seen[k]} times`,
        });
      });
    const defaults = members.filter((m) => m.isDefault);
    if (defaults.length > 1) {
      issues.push({
        severity: 'error',
        message: `${group}: DEFAULT=YES on ${defaults.length} renditions (${defaults.map((m) => m.name).join(', ')})`,
      });
    }
    members
      .filter((m) => m.isForced)
      .filter((m) => !members.some((o) => !o.isForced && (o.language || '').toLowerCase() === (m.language || '').toLowerCase()))
      .forEach((m) =>
        issues.push({
          severity: 'warn',
          message: `${group}: FORCED "${m.name}" (${m.language || 'no language'}) has no matching non-forced rendition`,
        })
      );
    members
      .filter((m) => m.type === 'SUBTITLES' && !m.uri)
      .forEach((m) => issues.push({ severity: 'error', message: `${group}: "${m.name}" has no URI` }));
    members
      .filter((m) => m.type === 'CLOSED-CAPTIONS' && !m.instreamId)
      .forEach((m) => issues.push({ severity: 'error', message: `${group}: "${m.name}" has no INSTREAM-ID` }));
  });
  const declared = (type: string): string[] => master.media.filter((m) => m.type === type).map((m) => m.groupId);
  const missing = (refs: Array<string | undefined>, type: string, attr: string): void =>
    refs
      .filter((r): r is string => !!r && r.toUpperCase() !== 'NONE')
      .filter((r, i, all) => all.indexOf(r) === i)
      .filter((r) => declared(type).indexOf(r) < 0)
      .forEach((r) =>
        issues.push({ severity: 'error', message: `Variants reference ${attr}="${r}" but no #EXT-X-MEDIA TYPE=${type} group has that id` })
      );
  missing(
    master.variants.map((v) => v.subtitles),
    'SUBTITLES',
    'SUBTITLES'
  );
  missing(
    master.variants.map((v) => v.closedCaptions),
    'CLOSED-CAPTIONS',
    'CLOSED-CAPTIONS'
  );
  missing(
    master.variants.map((v) => v.audio),
    'AUDIO',
    'AUDIO'
  );
  return issues;
};

/* ----------------------------------- WebVTT ----------------------------------- */

/** "hh:mm:ss.mmm" or "mm:ss.mmm" to seconds; NaN when malformed. */
export const parseVttTime = (s: string): number => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/.exec(s.trim());
  return m ? (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000 : NaN;
};

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '');

export const parseVtt = (text: string): VttFile => {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const isWebVtt = /^WEBVTT(\s|$)/.test(clean);
  let timestampMap: VttFile['timestampMap'];
  const map = /X-TIMESTAMP-MAP=[^\n]*?MPEGTS:(\d+)[^\n]*?LOCAL:([\d:.]+)|X-TIMESTAMP-MAP=[^\n]*?LOCAL:([\d:.]+)[^\n]*?MPEGTS:(\d+)/.exec(
    clean
  );
  if (map) {
    const mpegts = parseInt(map[1] || map[4], 10);
    const local = parseVttTime(map[2] || map[3]);
    timestampMap = { mpegts, local: isNaN(local) ? 0 : local };
  }
  const cues: Cue[] = [];
  clean.split(/\n{2,}/).forEach((block) => {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.indexOf('-->') >= 0);
    if (at < 0 || /^(NOTE|STYLE|REGION|WEBVTT)/.test(lines[0])) {
      return;
    }
    const [a, b] = lines[at].split('-->');
    const start = parseVttTime(a);
    const end = parseVttTime((b || '').trim().split(/\s+/)[0]);
    cues.push({ start, end, lines: lines.slice(at + 1).map(stripTags) });
  });
  return { isWebVtt, cues, timestampMap };
};

/** Offset (s) to add to cue times, per X-TIMESTAMP-MAP; 0 when absent. */
export const mapOffsetSec = (map?: { mpegts: number; local: number }): number => (map ? map.mpegts / 90000 - map.local : 0);

export interface TimestampMapReport {
  present: number;
  total: number;
  offsetsSec: number[];
}

export interface CueReport {
  total: number;
  firstStart?: number;
  lastEnd?: number;
  gaps: Array<{ from: number; to: number }>;
  overlaps: number;
  badTiming: number;
  empty: number;
  tooLong: number;
  longLines: number;
}

export const analyseCues = (cues: Cue[]): CueReport => {
  const seen: Record<string, boolean> = {};
  const unique = cues.filter((c) => {
    const k = `${c.start}|${c.end}|${c.lines.join('\n')}`;
    return seen[k] ? false : ((seen[k] = true), true);
  });
  const timed = unique.filter((c) => isFinite(c.start) && isFinite(c.end)).sort((a, b) => a.start - b.start);
  const gaps: CueReport['gaps'] = [];
  let overlaps = 0;
  let maxEnd = -Infinity;
  timed
    .filter((c) => c.end > c.start)
    .forEach((c) => {
      if (maxEnd > -Infinity) {
        if (c.start < maxEnd - 0.001) {
          overlaps++;
        } else if (c.start - maxEnd > GAP_SEC) {
          gaps.push({ from: maxEnd, to: c.start });
        }
      }
      maxEnd = Math.max(maxEnd, c.end);
    });
  return {
    total: unique.length,
    firstStart: timed.length ? timed[0].start : undefined,
    lastEnd: timed.length ? Math.max(...timed.map((c) => c.end)) : undefined,
    gaps,
    overlaps,
    badTiming: unique.filter((c) => !isFinite(c.start) || !isFinite(c.end) || c.end <= c.start).length,
    empty: unique.filter((c) => c.lines.join('').trim() === '').length,
    tooLong: timed.filter((c) => c.end - c.start > LONG_CUE_SEC).length,
    longLines: unique.filter((c) => c.lines.some((l) => l.length > MAX_LINE_CHARS)).length,
  };
};

/** Turn a cue report plus stream context into display issues. */
export const cueIssues = (r: CueReport, tsMap: TimestampMapReport, streamDuration: number | undefined, isPartial: boolean): Issue[] => {
  const out: Issue[] = [];
  if (!r.total) {
    out.push({ severity: 'warn', message: 'No cues found in the fetched segments' });
    return out;
  }
  r.gaps
    .slice(0, 5)
    .forEach((g) =>
      out.push({ severity: 'warn', message: `Gap of ${(g.to - g.from).toFixed(1)}s between ${g.from.toFixed(1)}s and ${g.to.toFixed(1)}s` })
    );
  if (r.gaps.length > 5) {
    out.push({ severity: 'warn', message: `${r.gaps.length - 5} more gaps over ${GAP_SEC}s` });
  }
  if (r.overlaps) {
    out.push({ severity: 'warn', message: `${r.overlaps} overlapping cue(s)` });
  }
  if (r.badTiming) {
    out.push({ severity: 'error', message: `${r.badTiming} cue(s) with end <= start or unparseable timing` });
  }
  if (r.empty) {
    out.push({ severity: 'warn', message: `${r.empty} empty cue(s)` });
  }
  if (r.tooLong) {
    out.push({ severity: 'info', message: `${r.tooLong} cue(s) longer than ${LONG_CUE_SEC}s` });
  }
  if (r.longLines) {
    out.push({ severity: 'info', message: `${r.longLines} cue(s) with a line over ${MAX_LINE_CHARS} characters` });
  }
  if (tsMap.present > 0 && tsMap.present < tsMap.total) {
    out.push({ severity: 'warn', message: `X-TIMESTAMP-MAP in ${tsMap.present} of ${tsMap.total} segments` });
  }
  if (tsMap.offsetsSec.filter((o, i, all) => all.indexOf(o) === i).length > 1) {
    out.push({ severity: 'warn', message: 'X-TIMESTAMP-MAP offset differs between segments' });
  }
  if (tsMap.present === 0 && tsMap.total > 0) {
    out.push({ severity: 'info', message: 'No X-TIMESTAMP-MAP (cue times assumed to match media time)' });
  }
  if (streamDuration !== undefined && !isPartial && r.lastEnd !== undefined && r.lastEnd > streamDuration + 2) {
    out.push({
      severity: 'warn',
      message: `Last cue ends at ${r.lastEnd.toFixed(1)}s, after the stream duration (${streamDuration.toFixed(1)}s)`,
    });
  }
  return out;
};

export const formatSec = (s: number | undefined): string => {
  if (s === undefined || !isFinite(s)) {
    return '—';
  }
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  return `${m}:${((tenths - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
};
