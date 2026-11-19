/** Pure builder and HTML renderer for the "Export report" file. No Angular imports. */
import { AuditResult, buildAudit } from '../bitrate-audit/bitrate-audit.logic';
import { buildRow, detectSingleBitrate, EdgeRow, EdgeSummary, orderRows, summarize } from '../edge-view/edge-view.logic';
import { Check, runChecks, RefRung, Rung, rungsFromLevels } from '../ladder-check/ladder-check.logic';
import { computeStartup, toJson as startupToJson } from '../startup-waterfall/startup-waterfall.logic';
import { redact, redactDeep } from './report-redact.logic';

export const LOG_TAIL = 50;
const MAX_EDGE_ROWS = 40;
const PLAYLIST_KINDS = ['master', 'variant', 'audio-playlist', 'subtitle-playlist'];

export interface ReportRecord {
  id: number;
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
  status?: number;
  error?: string;
  tRequest: number;
  tFirstByte?: number;
  tLoaded?: number;
  headers?: Record<string, string>;
}

export interface ReportIssue {
  severity: string;
  code: string;
  message: string;
}

/** Everything buildReport needs, already gathered from the viewer. Plain data only. */
export interface ReportState {
  now: Date;
  appVersion?: string;
  userAgent: string;
  manifestUrl: string;
  records: ReportRecord[];
  declaredLevels: { bandwidth?: number; averageBandwidth?: number; resolution?: string; frameRate?: number }[];
  sessionStart?: number;
  references: { name: string; ladder: RefRung[] }[];
  lintIssues: ReportIssue[];
  videoErrors: string[];
  logs: string[];
  deviceProfile?: { id: string; label: string; maxHeight: number | null; bandwidthMbps: number | null; latencyMs: number };
  audioTrack?: string;
  singleBitrateKey: string;
  playerState?: string;
}

export interface Report {
  generatedAt: string;
  appVersion?: string;
  userAgent: string;
  manifestUrl: string;
  singleBitrate: string;
  deviceProfile?: ReportState['deviceProfile'];
  audioTrack?: string;
  playerState?: string;
  ladder: { rungs: Rung[]; checks: Check[] };
  lint: ReportIssue[];
  audit: AuditResult;
  startup: object;
  edge: { summary: EdgeSummary; singleBitrate: { isSingle: boolean; reason: string }; playlists: EdgeRow[] };
  errors: { videoErrors: string[]; failedRequests: { kind: string; url: string; status?: number; error?: string }[] };
  logTail: string[];
}

export const buildReport = (s: ReportState): Report => {
  const rungs = rungsFromLevels(s.declaredLevels);
  const rows = orderRows(s.records.map(buildRow));
  const rates = s.declaredLevels.filter((l) => !!l.bandwidth).map((l) => l.bandwidth as number);
  const declaredVideoVariants = s.records.filter((r) => r.kind === 'variant' && r.level !== undefined).length;
  const report: Report = {
    generatedAt: s.now.toISOString(),
    appVersion: s.appVersion,
    userAgent: s.userAgent,
    manifestUrl: redact(s.manifestUrl),
    singleBitrate: s.singleBitrateKey || 'full ladder',
    deviceProfile: s.deviceProfile,
    audioTrack: s.audioTrack,
    playerState: s.playerState,
    ladder: { rungs, checks: runChecks(rungs, s.references) },
    lint: s.lintIssues,
    audit: buildAudit(s.records),
    startup: startupToJson(computeStartup(s.records, s.sessionStart, undefined, rates)),
    edge: {
      summary: summarize(rows),
      singleBitrate: detectSingleBitrate({ records: s.records, declaredVideoVariants }),
      playlists: rows.filter((r) => PLAYLIST_KINDS.indexOf(r.kind) >= 0).slice(0, MAX_EDGE_ROWS),
    },
    errors: {
      videoErrors: s.videoErrors,
      failedRequests: s.records
        .filter((r) => !!r.error || (r.status !== undefined && r.status >= 400))
        .slice(0, MAX_EDGE_ROWS)
        .map((r) => ({ kind: r.kind, url: redact(r.url), status: r.status, error: r.error })),
    },
    logTail: s.logs.slice(-LOG_TAIL),
  };
  return redactDeep(report);
};

export const escapeHtml = (v: unknown): string =>
  String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const e = escapeHtml;
const kbps = (bps?: number): string => (bps ? String(Math.round(bps / 1000)) : '-');
const table = (head: string[], body: unknown[][]): string =>
  body.length
    ? `<table><thead><tr>${head.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${body
        .map((row) => `<tr>${row.map((c) => `<td>${e(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p class="muted">none</p>';
const section = (title: string, inner: string): string => `<section><h2>${e(title)}</h2>${inner}</section>`;
const kv = (pairs: [string, unknown][]): string => table(['Field', 'Value'], pairs);

const STYLE =
  'body{font:14px/1.45 -apple-system,Segoe UI,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#222}' +
  'h1{font-size:20px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ddd}' +
  'table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ddd;padding:3px 6px;text-align:left;vertical-align:top;word-break:break-all}' +
  'th{background:#f3f3f3}.muted{color:#777}pre{background:#f6f6f6;padding:8px;overflow:auto;font-size:11px;white-space:pre-wrap}';

/** Self-contained HTML (no scripts, no external assets). Every dynamic value is escaped. */
export const renderReportHtml = (r: Report): string => {
  const parts = [
    section(
      'Session',
      kv([
        ['Generated', r.generatedAt],
        ['MOE viewer version', r.appVersion],
        ['Browser', r.userAgent],
        ['Manifest (tokens redacted)', r.manifestUrl],
        ['Single-bitrate rendition', r.singleBitrate],
        ['Device profile', r.deviceProfile ? `${r.deviceProfile.label} (${r.deviceProfile.id})` : ''],
        ['Audio track', r.audioTrack],
        ['Player state', r.playerState],
      ])
    ),
    section(
      'Master ladder',
      table(
        ['Resolution', 'BANDWIDTH kbps', 'AVERAGE-BANDWIDTH kbps', 'FPS'],
        r.ladder.rungs.map((g) => [`${g.width}x${g.height}`, kbps(g.peak), kbps(g.avg), g.fps])
      )
    ),
    section('Ladder check findings', table(['Check', 'Detail'], r.ladder.checks.map((c) => [c.label, c.detail]))),
    section(
      'Manifest lint (HLS + Peloton rules)',
      table(['Severity', 'Code', 'Message'], r.lint.map((i) => [i.severity, i.code, i.message]))
    ),
    section(
      'Declared vs delivered',
      table(
        ['Level', 'Resolution', 'Declared peak kbps', 'Declared avg kbps', 'Measured peak kbps', 'Measured avg kbps', 'Peak %', 'Avg %', 'Segments'],
        r.audit.video.map((v) => [
          v.level,
          v.resolution,
          v.bandwidthKbps,
          v.averageBandwidthKbps,
          v.peakKbps && Math.round(v.peakKbps),
          v.avgKbps && Math.round(v.avgKbps),
          v.peakPct && Math.round(v.peakPct),
          v.avgPct && Math.round(v.avgPct),
          v.segments,
        ])
      )
    ),
    section('Startup waterfall', renderStartup(r.startup as any)),
    section(
      'Akamai edge',
      kv([
        ['Segments (classified)', `${r.edge.summary.segments} (${r.edge.summary.classifiedSegments})`],
        ['Cache hits / misses', `${r.edge.summary.hits} / ${r.edge.summary.misses}`],
        ['Hit ratio', r.edge.summary.hitRatio === undefined ? '-' : Math.round(r.edge.summary.hitRatio * 100) + '%'],
        ['Median edge / origin ms', `${r.edge.summary.medianEdgeDurMs ?? '-'} / ${r.edge.summary.medianOriginDurMs ?? '-'}`],
        ['EdgeWorker seen', r.edge.summary.edgeWorkerSeen],
        ['Single bitrate served', r.edge.singleBitrate.isSingle ? 'yes: ' + r.edge.singleBitrate.reason : 'no'],
      ]) +
        table(
          ['Kind', 'Path', 'Status', 'Cache', 'Served by', 'Edge ms', 'Origin ms'],
          r.edge.playlists.map((p) => [p.kind, p.path, p.status, p.cache.label, p.servedBy, p.edgeDurMs, p.originDurMs])
        )
    ),
    section(
      'Errors and issues',
      table(['Player / video error'], r.errors.videoErrors.map((m) => [m])) +
        table(['Kind', 'URL', 'Status', 'Error'], r.errors.failedRequests.map((f) => [f.kind, f.url, f.status, f.error]))
    ),
    section(`Player logs (last ${LOG_TAIL}, redacted)`, `<pre>${e(r.logTail.join('\n'))}</pre>`),
    section('Raw JSON', `<pre>${e(JSON.stringify(r, null, 2))}</pre>`),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MOE session report</title><style>${STYLE}</style></head><body><h1>MOE session report</h1>${parts.join('')}</body></html>`;
};

const renderStartup = (s: { joinMs?: number | null; masterTtfbMs?: number | null; startedOnRung?: string | null; rows?: any[] }): string =>
  kv([
    ['Join (master to first segment) ms', s.joinMs],
    ['Master TTFB ms', s.masterTtfbMs],
    ['Started on rung', s.startedOnRung],
  ]) +
  table(
    ['Step', 'Rendition', 'Start ms', 'TTFB ms', 'Download ms', 'Bytes'],
    (s.rows || []).map((x) => [x.name, x.rendition, x.startMs, x.ttfbMs, x.downloadMs, x.bytes])
  );

export const reportFileName = (r: Report, ext: 'html' | 'json'): string =>
  `moe-session-report-${r.generatedAt.replace(/[:.]/g, '-')}.${ext}`;
