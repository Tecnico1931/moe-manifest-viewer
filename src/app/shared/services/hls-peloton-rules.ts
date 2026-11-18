import { HlsIssue, HlsIssueCategory, HlsIssueSeverity } from '../models/hls-issue.model';

/**
 * Peloton-relevant HLS lint rules. Pure functions, no Angular dependencies.
 * Entry point: runPelotonRules(). Codes use the "PL" prefix.
 */
export const PELOTON_ISSUE_CODES = {
  CODEC_LEGACY_AVC: 'PL001',
  CODEC_MALFORMED: 'PL002',
  AVG_BANDWIDTH_ALL_EQUAL: 'PL010',
  AVG_BANDWIDTH_MISSING: 'PL011',
  AVG_BANDWIDTH_EXCEEDS_PEAK: 'PL012',
  PEAK_AVG_RATIO: 'PL013',
  SEGMENT_DURATION_DRIFT: 'PL020',
  CROSS_VARIANT_DURATION: 'PL021',
  LADDER_NEAR_DUPLICATE: 'PL030',
  VIDEO_RESOLUTION_MISSING: 'PL031',
  CMCD_BR_TOO_LOW: 'PL040',
  LIVE_LONG_SEGMENTS: 'PL050',
} as const;

const APPLE_AUTHORING = 'Apple HLS Authoring Specification';
const MP4A_OK = ['2', '5', '29', '34', '42'];
const VIDEO_CODEC_RE = /^(avc[13]|hvc1|hev1|dvh1|dvhe|av01|vp09)/i;
const MAX_LISTED = 8;

interface Variant {
  lineNumber: number;
  uri: string;
  attrs: Record<string, string>;
  bandwidth?: number;
  average?: number;
  label: string;
}

export function parseAttributeList(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function issue(
  code: string,
  severity: HlsIssueSeverity,
  category: HlsIssueCategory,
  message: string,
  details: string,
  lineNumber?: number,
  specReference?: string
): HlsIssue {
  return { code, severity, category, message, details, lineNumber, specReference };
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function listCapped(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${shown}; +${items.length - MAX_LISTED} more` : shown;
}

export function parseVariants(lines: string[]): Variant[] {
  const out: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      continue;
    }
    const attrs = parseAttributeList(lines[i].substring('#EXT-X-STREAM-INF:'.length));
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith('#')) {
        uri = lines[j];
        break;
      }
      if (lines[j].startsWith('#EXT-X-STREAM-INF:')) {
        break;
      }
    }
    const bandwidth = attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : undefined;
    const average = attrs['AVERAGE-BANDWIDTH'] ? parseInt(attrs['AVERAGE-BANDWIDTH'], 10) : undefined;
    const kbps = bandwidth ? `${Math.round(bandwidth / 1000)}k` : '?';
    out.push({
      lineNumber: i + 1,
      uri,
      attrs,
      bandwidth,
      average,
      label: `${attrs.RESOLUTION || 'no-res'}@${kbps} (${uri || 'no URI'})`,
    });
  }
  return out;
}

/** Rule 1: CODECS string forms. */
export function checkCodecString(codec: string): { code: string; message: string; fix?: string } | null {
  const c = codec.trim();
  const avc = /^(avc[13])\.(.+)$/i.exec(c);
  if (avc) {
    const rest = avc[2];
    if (/^[0-9A-Fa-f]{6}$/.test(rest)) {
      return null;
    }
    const legacy = /^(\d+)\.(\d+)$/.exec(rest);
    if (legacy) {
      const profile = parseInt(legacy[1], 10);
      const level = parseInt(legacy[2], 10);
      if (profile < 256 && level < 256) {
        // Constraint byte as encoders usually write it: Baseline e0 (constrained), Main 40, others 00.
        const constraint = profile === 66 ? 'e0' : profile === 77 ? '40' : '00';
        const fix = `${avc[1].toLowerCase()}.${hex2(profile)}${constraint}${hex2(level)}`;
        return { code: PELOTON_ISSUE_CODES.CODEC_LEGACY_AVC, message: `legacy decimal form`, fix };
      }
    }
    return { code: PELOTON_ISSUE_CODES.CODEC_MALFORMED, message: 'profile/level is not 6 hex digits (RFC 6381)' };
  }
  const aac = /^mp4a\.40\.(\w+)$/i.exec(c);
  if (aac) {
    if (!/^\d+$/.test(aac[1]) || String(parseInt(aac[1], 10)) !== aac[1] || MP4A_OK.indexOf(aac[1]) < 0) {
      return { code: PELOTON_ISSUE_CODES.CODEC_MALFORMED, message: 'not one of mp4a.40.2/5/29/34', fix: undefined };
    }
    return null;
  }
  if (/^mp4a\./i.test(c) && !/^mp4a\.(69|6b|a5|a6)$/i.test(c)) {
    return { code: PELOTON_ISSUE_CODES.CODEC_MALFORMED, message: 'unrecognized mp4a object type' };
  }
  if (/^(hev1|hvc1)\./i.test(c)) {
    const ok = /^(hev1|hvc1)\.[ABC]?\d+\.[0-9A-Fa-f]{1,8}\.[LH]\d+(\.[0-9A-Fa-f]{1,2}){0,6}$/.test(c);
    return ok ? null : { code: PELOTON_ISSUE_CODES.CODEC_MALFORMED, message: 'malformed HEVC string (expected hvc1.<profile>.<compat>.<L|H><level>[.constraints])' };
  }
  return null;
}

function codecIssues(variants: Variant[]): HlsIssue[] {
  const out: HlsIssue[] = [];
  for (const v of variants) {
    if (!v.attrs.CODECS) {
      continue;
    }
    for (const codec of v.attrs.CODECS.split(',')) {
      const res = checkCodecString(codec);
      if (!res) {
        continue;
      }
      const hint = res.fix ? ` Likely ${res.fix} (check the encoder's constraint flags).` : '';
      out.push(
        issue(
          res.code,
          'warning',
          'master-playlist',
          res.fix ? `Legacy CODECS "${codec.trim()}"` : `Suspicious CODECS "${codec.trim()}"`,
          `${v.label}: ${res.message}.${hint}`,
          v.lineNumber,
          'RFC 6381'
        )
      );
    }
  }
  return out;
}

function bandwidthIssues(variants: Variant[]): HlsIssue[] {
  const out: HlsIssue[] = [];
  const withBw = variants.filter((v) => v.bandwidth);

  for (const v of withBw) {
    if (v.average === undefined) {
      out.push(
        issue(PELOTON_ISSUE_CODES.AVG_BANDWIDTH_MISSING, 'warning', 'master-playlist', 'Missing AVERAGE-BANDWIDTH',
          `${v.label}: the authoring spec expects AVERAGE-BANDWIDTH on every variant (VOD).`, v.lineNumber, APPLE_AUTHORING)
      );
    } else if (v.average > (v.bandwidth as number)) {
      out.push(
        issue(PELOTON_ISSUE_CODES.AVG_BANDWIDTH_EXCEEDS_PEAK, 'error', 'master-playlist', 'AVERAGE-BANDWIDTH exceeds BANDWIDTH',
          `${v.label}: AVERAGE-BANDWIDTH ${v.average} > BANDWIDTH ${v.bandwidth}.`, v.lineNumber, 'RFC 8216 Section 4.3.4.2')
      );
    }
  }

  const withAvg = withBw.filter((v) => v.average !== undefined);
  const allEqual = withAvg.length >= 2 && withAvg.length === withBw.length && withAvg.every((v) => v.average === v.bandwidth);
  if (allEqual) {
    out.push(
      issue(PELOTON_ISSUE_CODES.AVG_BANDWIDTH_ALL_EQUAL, 'warning', 'master-playlist',
        'AVERAGE-BANDWIDTH equals BANDWIDTH on every variant',
        'Looks copied rather than measured. Peak and average should differ for VBR/capped-VBR encodes.',
        withAvg[0].lineNumber, APPLE_AUTHORING)
    );
  }

  if (!allEqual) {
    const odd: string[] = [];
    for (const v of withAvg) {
      if (!v.average || v.average > (v.bandwidth as number)) {
        continue;
      }
      const ratio = (v.bandwidth as number) / v.average;
      if (ratio < 1.1 || ratio > 2.0) {
        odd.push(`${v.attrs.RESOLUTION || 'no-res'}@${Math.round((v.bandwidth as number) / 1000)}k ratio ${ratio.toFixed(2)}`);
      }
    }
    if (odd.length > 0) {
      const first = withAvg.find((v) => v.average !== undefined && v.average <= (v.bandwidth as number));
      out.push(
        issue(PELOTON_ISSUE_CODES.PEAK_AVG_RATIO, 'info', 'best-practice',
          `Peak/average ratio outside 1.1-2.0 on ${odd.length} variant(s)`, listCapped(odd), first && first.lineNumber, APPLE_AUTHORING)
      );
    }
  }
  return out;
}

function ladderIssues(variants: Variant[]): HlsIssue[] {
  const out: HlsIssue[] = [];
  const groups: Record<string, Variant[]> = {};
  for (const v of variants) {
    if (!v.attrs.RESOLUTION || !v.bandwidth) {
      continue;
    }
    const videoCodec = (v.attrs.CODECS || '').split(',').map((s) => s.trim()).find((s) => VIDEO_CODEC_RE.test(s)) || '';
    const key = [v.attrs.RESOLUTION, v.attrs['FRAME-RATE'] || '', videoCodec.split('.')[0], v.attrs.AUDIO || ''].join('|');
    (groups[key] = groups[key] || []).push(v);
  }
  Object.keys(groups).forEach((key) => {
    const g = groups[key].slice().sort((a, b) => (a.bandwidth as number) - (b.bandwidth as number));
    for (let i = 1; i < g.length; i++) {
      const lo = g[i - 1].bandwidth as number;
      const hi = g[i].bandwidth as number;
      if ((hi - lo) / hi < 0.1) {
        out.push(
          issue(PELOTON_ISSUE_CODES.LADDER_NEAR_DUPLICATE, 'warning', 'master-playlist',
            `Near-duplicate rungs at ${g[i].attrs.RESOLUTION}`,
            `${lo} vs ${hi} bps (${(((hi - lo) / hi) * 100).toFixed(1)}% apart): ${g[i - 1].uri} / ${g[i].uri}`,
            g[i].lineNumber, APPLE_AUTHORING)
        );
      }
    }
  });

  // Video variants (CODECS has a video codec and an audio codec) with no RESOLUTION.
  // M003 already covers CODECS without mp4a.; this covers muxed audio+video.
  for (const v of variants) {
    const codecs = (v.attrs.CODECS || '').split(',').map((s) => s.trim());
    if (!v.attrs.RESOLUTION && codecs.some((c) => VIDEO_CODEC_RE.test(c)) && codecs.some((c) => /^mp4a\./i.test(c))) {
      out.push(
        issue(PELOTON_ISSUE_CODES.VIDEO_RESOLUTION_MISSING, 'warning', 'master-playlist', 'Video variant missing RESOLUTION',
          `${v.label}: CODECS lists video and audio but RESOLUTION is absent.`, v.lineNumber, APPLE_AUTHORING)
      );
    }
  }
  return out;
}

/** Rule 7: CMCD br visible only when a variant URI carries a CMCD query parameter. */
function cmcdIssues(variants: Variant[]): HlsIssue[] {
  const out: HlsIssue[] = [];
  for (const v of variants) {
    const q = v.uri.split('?')[1];
    if (!q || !v.bandwidth) {
      continue;
    }
    const cmcdParam = q.split('&').find((p) => p.startsWith('CMCD='));
    if (!cmcdParam) {
      continue;
    }
    let decoded = '';
    try {
      decoded = decodeURIComponent(cmcdParam.substring(5));
    } catch (e) {
      continue;
    }
    const br = /(?:^|,)br=(\d+)/.exec(decoded);
    if (br && parseInt(br[1], 10) < (v.bandwidth / 1000) * 0.2) {
      out.push(
        issue(PELOTON_ISSUE_CODES.CMCD_BR_TOO_LOW, 'warning', 'best-practice', 'CMCD br far below declared BANDWIDTH',
          `${v.label}: br=${br[1]} kbps vs ${Math.round(v.bandwidth / 1000)} kbps declared (<20%).`, v.lineNumber, 'CTA-5004')
      );
    }
  }
  return out;
}

interface Segment {
  lineNumber: number;
  duration: number;
}

function parseSegments(lines: string[]): Segment[] {
  const segs: Segment[] = [];
  lines.forEach((l, i) => {
    const m = /^#EXTINF:(\d+(?:\.\d+)?)/.exec(l);
    if (m) {
      segs.push({ lineNumber: i + 1, duration: parseFloat(m[1]) });
    }
  });
  return segs;
}

function targetDuration(lines: string[]): { value: number; lineNumber: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-TARGETDURATION:(\d+)/.exec(lines[i]);
    if (m) {
      return { value: parseInt(m[1], 10), lineNumber: i + 1 };
    }
  }
  return null;
}

function mediaIssues(lines: string[]): HlsIssue[] {
  const out: HlsIssue[] = [];
  const target = targetDuration(lines);
  if (!target) {
    return out;
  }
  // Rule 5a: drift from TARGETDURATION, last segment exempt. (EXTINF > target is D001.)
  const segs = parseSegments(lines).slice(0, -1);
  const drift = segs.filter((s) => Math.abs(s.duration - target.value) > 0.5);
  if (drift.length > 0) {
    out.push(
      issue(PELOTON_ISSUE_CODES.SEGMENT_DURATION_DRIFT, 'warning', 'duration',
        `${drift.length} segment(s) deviate >0.5s from TARGETDURATION ${target.value}s`,
        listCapped(drift.map((s) => `line ${s.lineNumber}: ${s.duration}s`)), drift[0].lineNumber, APPLE_AUTHORING)
    );
  }
  // Rule 8: live, long segments, no low-latency parts.
  const isLive = !lines.some((l) => l.startsWith('#EXT-X-ENDLIST'));
  const hasParts = lines.some((l) => l.startsWith('#EXT-X-PART') || l.startsWith('#EXT-X-SERVER-CONTROL'));
  if (isLive && target.value >= 10 && !hasParts) {
    out.push(
      issue(PELOTON_ISSUE_CODES.LIVE_LONG_SEGMENTS, 'info', 'best-practice',
        `Live TARGETDURATION ${target.value}s with no EXT-X-PART`,
        'Long segments slow startup. Peloton live uses 12 s; consider shorter segments or LL-HLS parts.',
        target.lineNumber, APPLE_AUTHORING)
    );
  }
  return out;
}

/** Rule 5b: compare EXTINF at the same media sequence across variants. Needs several playlists. */
export function checkCrossVariantDurations(playlists: Array<{ name: string; text: string }>): HlsIssue[] {
  const bySeq: Record<number, Array<{ name: string; duration: number }>> = {};
  for (const p of playlists) {
    const lines = p.text.split('\n').map((l) => l.trim());
    const msLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
    const base = msLine ? parseInt(msLine.split(':')[1], 10) : 0;
    parseSegments(lines).forEach((s, idx) => {
      (bySeq[base + idx] = bySeq[base + idx] || []).push({ name: p.name, duration: s.duration });
    });
  }
  const bad: string[] = [];
  Object.keys(bySeq).forEach((k) => {
    const e = bySeq[+k];
    if (e.length < 2) {
      return;
    }
    const ds = e.map((x) => x.duration);
    if (Math.max(...ds) - Math.min(...ds) > 0.05) {
      bad.push(`seq ${k}: ${e.map((x) => `${x.name}=${x.duration}s`).join(', ')}`);
    }
  });
  if (bad.length === 0) {
    return [];
  }
  return [
    issue(PELOTON_ISSUE_CODES.CROSS_VARIANT_DURATION, 'info', 'duration',
      `Segment durations differ across variants at ${bad.length} sequence number(s)`, listCapped(bad), undefined, APPLE_AUTHORING),
  ];
}

export function runPelotonRules(manifest: string, isMedia: boolean): HlsIssue[] {
  const lines = manifest.split('\n').map((l) => l.trim());
  if (isMedia) {
    return mediaIssues(lines);
  }
  const variants = parseVariants(lines);
  return [...codecIssues(variants), ...bandwidthIssues(variants), ...ladderIssues(variants), ...cmcdIssues(variants)];
}
