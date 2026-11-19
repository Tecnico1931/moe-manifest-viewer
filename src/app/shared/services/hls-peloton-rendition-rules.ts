import { HlsIssue, HlsIssueSeverity } from '../models/hls-issue.model';

/**
 * Peloton rendition-name lint. Pure functions, no Angular dependencies.
 * Checks that variant URIs and RESOLUTION attributes match what the Akamai edge expects.
 *
 * Sources (read-only research, 2026-11):
 * - Variant playlists are named master_<modifier>.m3u8 (modifier = MediaConvert NameModifier):
 *   projects/ffmpeg-tools/mediaconvert/build_template.py LADDER (_4800k, _900p, _3000k, _1800k, _432p)
 *   and manifest-decoder/test/peloton-vod-fixture.m3u8 (live vod-v2 ladder: _4800k 1080p, _3000k 720p,
 *   _1800k 540p, _1000k 360p, _600k 288p). The numeric part is a legacy cap label, not the measured
 *   bitrate: v3 keeps "_4800k" on a 3.1 Mbps cap.
 * - Older classes use 6000k/8000k ladders: projects/ffmpeg-tools/notes/podium-per-title-business-case.md.
 * - Single-bitrate EdgeWorker selects by RESOLUTION height, default 720, nearest height otherwise, highest
 *   BANDWIDTH per height, and skips variants with no parseable RESOLUTION:
 *   akamai-edgeworkers/single-bitrate/{manipulators.js,constants.js,README.md}.
 * - The _720p reroute (Single-Rendition Failover Path) serves <name>_720p.m3u8, a sibling built from the
 *   _3000k rung (build_template.py AdditionalManifests): media-cloud-main/.claude/akamai/references/
 *   system-model.md ("The failover / reroute leg"). That sibling only works if the ladder has a 720p rung.
 */
export const RENDITION_ISSUE_CODES = {
  RENDITION_NAME_MISSING: 'PL060',
  RENDITION_NAME_UNRECOGNISED: 'PL061',
  RENDITION_NAME_BITRATE_MISMATCH: 'PL062',
  RENDITION_NAME_HEIGHT_MISMATCH: 'PL063',
  RENDITION_RESOLUTION_MISSING: 'PL064',
  RENDITION_NO_720P: 'PL065',
  RENDITION_DUPLICATE_HEIGHT: 'PL066',
  RENDITION_LEGACY_LADDER: 'PL067',
} as const;

/** Name modifiers produced by the vod-v2/v3 ladders (bitrate-style labels). */
export const KNOWN_BITRATE_MODIFIERS = [600, 1000, 1800, 3000, 4800];
/** Older ladders, still on disk for older classes. */
export const LEGACY_BITRATE_MODIFIERS = [6000, 8000];

// Name label vs declared BANDWIDTH. Labels are caps, so BANDWIDTH above ~1.25x is wrong; far below is just per-title.
const OVER_RATIO = 1.25;
const UNDER_RATIO = 0.15;
const TARGET_HEIGHT = 720;

export interface RenditionVariant {
  lineNumber: number;
  uri: string;
  attrs: Record<string, string>;
  bandwidth?: number;
  label: string;
}

export interface RenditionName {
  file: string;
  modifier: string | null;
  kind: 'bitrate' | 'height' | 'other' | 'none';
  value: number;
}

export function parseRenditionName(uri: string): RenditionName {
  const path = uri.split('?')[0];
  const file = path.substring(path.lastIndexOf('/') + 1);
  const m = /^([^_]+)(?:_([^.]+))?\.m3u8$/i.exec(file);
  if (!m || !m[2]) {
    return { file, modifier: null, kind: 'none', value: 0 };
  }
  const mod = m[2];
  const bit = /^(\d+)k$/.exec(mod);
  if (bit) {
    return { file, modifier: mod, kind: 'bitrate', value: parseInt(bit[1], 10) };
  }
  const h = /^(\d+)p$/.exec(mod);
  if (h) {
    return { file, modifier: mod, kind: 'height', value: parseInt(h[1], 10) };
  }
  return { file, modifier: mod, kind: 'other', value: 0 };
}

function heightOf(v: RenditionVariant): number | undefined {
  const m = /^\d+x(\d+)$/.exec(v.attrs.RESOLUTION || '');
  return m ? parseInt(m[1], 10) : undefined;
}

function isVideoVariant(v: RenditionVariant): boolean {
  if (!v.attrs.CODECS) {
    return true;
  }
  return v.attrs.CODECS.split(',').some((c) => /^(avc[13]|hvc1|hev1|dvh1|dvhe|av01|vp09)/i.test(c.trim()));
}

function mk(
  code: string,
  severity: HlsIssueSeverity,
  message: string,
  details: string,
  v?: RenditionVariant
): HlsIssue {
  return {
    code,
    severity,
    category: 'best-practice',
    message,
    details: v ? `${v.label}: ${details}` : details,
    lineNumber: v && v.lineNumber,
    specReference: 'Peloton edge: single-bitrate EdgeWorker / _720p reroute',
  };
}

export function renditionNameIssues(all: RenditionVariant[]): HlsIssue[] {
  const variants = all.filter((v) => v.uri && isVideoVariant(v));
  const names = variants.map((v) => parseRenditionName(v.uri));
  // Only lint Peloton-style masters (master_<modifier>.m3u8 naming) so generic streams stay quiet.
  const isPeloton = names.some((n) => /^master$/i.test(n.file.split(/[_.]/)[0]) && n.kind !== 'none') ||
    names.some((n) => n.kind === 'bitrate' && KNOWN_BITRATE_MODIFIERS.concat(LEGACY_BITRATE_MODIFIERS).indexOf(n.value) >= 0);
  if (!isPeloton) {
    return [];
  }
  const out: HlsIssue[] = [];
  const legacy: RenditionVariant[] = [];

  variants.forEach((v, i) => {
    const n = names[i];
    if (n.kind === 'none') {
      out.push(mk(RENDITION_ISSUE_CODES.RENDITION_NAME_MISSING, 'warning', 'Variant URI has no rendition name modifier',
        `"${n.file}" has no _<modifier> (expected e.g. master_3000k.m3u8).`, v));
    } else if (n.kind === 'other') {
      out.push(mk(RENDITION_ISSUE_CODES.RENDITION_NAME_UNRECOGNISED, 'warning', `Unrecognised rendition modifier "_${n.modifier}"`,
        'expected a bitrate label (_4800k, _3000k, ...) or height label (_900p, _432p).', v));
    } else if (n.kind === 'bitrate') {
      if (LEGACY_BITRATE_MODIFIERS.indexOf(n.value) >= 0) {
        legacy.push(v);
      } else if (KNOWN_BITRATE_MODIFIERS.indexOf(n.value) < 0) {
        out.push(mk(RENDITION_ISSUE_CODES.RENDITION_NAME_UNRECOGNISED, 'warning', `Unrecognised rendition modifier "_${n.modifier}"`,
          `known ladder labels: ${KNOWN_BITRATE_MODIFIERS.concat(LEGACY_BITRATE_MODIFIERS).map((k) => `_${k}k`).join(', ')}.`, v));
      }
      if (v.bandwidth && n.value > 0) {
        const kbps = v.bandwidth / 1000;
        if (kbps > n.value * OVER_RATIO) {
          out.push(mk(RENDITION_ISSUE_CODES.RENDITION_NAME_BITRATE_MISMATCH, 'warning', `BANDWIDTH exceeds name label ${n.modifier}`,
            `declares ${Math.round(kbps)} kbps, more than ${OVER_RATIO}x the "${n.modifier}" cap label.`, v));
        } else if (kbps < n.value * UNDER_RATIO) {
          out.push(mk(RENDITION_ISSUE_CODES.RENDITION_NAME_BITRATE_MISMATCH, 'info', `BANDWIDTH far below name label ${n.modifier}`,
            `declares ${Math.round(kbps)} kbps, under ${Math.round(UNDER_RATIO * 100)}% of the "${n.modifier}" label (labels are legacy caps).`, v));
        }
      }
    } else if (n.kind === 'height') {
      const h = heightOf(v);
      if (h !== undefined && h !== n.value) {
        out.push(mk(RENDITION_ISSUE_CODES.RENDITION_NAME_HEIGHT_MISMATCH, 'warning', `Name "_${n.modifier}" does not match RESOLUTION height ${h}`,
          'height-style modifiers should equal the RESOLUTION height.', v));
      }
    }
  });

  // single-bitrate selects by RESOLUTION height and skips variants without it.
  variants.filter((v) => heightOf(v) === undefined).forEach((v) => {
    out.push(mk(RENDITION_ISSUE_CODES.RENDITION_RESOLUTION_MISSING, 'warning', 'Variant has no RESOLUTION; single-bitrate selection skips it',
      'the EdgeWorker maps ?rendition= to a RESOLUTION height and ignores variants without one.', v));
  });

  const heights = variants.map(heightOf).filter((h) => h !== undefined) as number[];
  if (heights.length > 0 && heights.indexOf(TARGET_HEIGHT) < 0) {
    const first = variants.find((v) => heightOf(v) !== undefined) as RenditionVariant;
    out.push(mk(RENDITION_ISSUE_CODES.RENDITION_NO_720P, 'warning', 'No 720p rung: _720p reroute and default selection have no exact match',
      `heights present: ${Array.from(new Set(heights)).sort((a, b) => b - a).join(', ')}. The failover _720p sibling and the default rendition=sd target ${TARGET_HEIGHT}p.`, first));
  }

  const seen: Record<number, RenditionVariant[]> = {};
  variants.forEach((v) => {
    const h = heightOf(v);
    if (h !== undefined) {
      (seen[h] = seen[h] || []).push(v);
    }
  });
  Object.keys(seen).forEach((k) => {
    const g = seen[+k];
    if (g.length > 1) {
      out.push(mk(RENDITION_ISSUE_CODES.RENDITION_DUPLICATE_HEIGHT, 'info', `${g.length} variants share height ${k}p`,
        `single-bitrate keeps only the highest BANDWIDTH at a height: ${g.map((x) => parseRenditionName(x.uri).file).join(', ')}.`,
        g[1]));
    }
  });

  if (legacy.length > 0) {
    out.push(mk(RENDITION_ISSUE_CODES.RENDITION_LEGACY_LADDER, 'info', 'Legacy 6000k/8000k ladder',
      `older-class ladder (${legacy.map((v) => parseRenditionName(v.uri).modifier).join(', ')}); the current vod-v2 ladder tops out at _4800k.`, legacy[0]));
  }
  return out;
}
