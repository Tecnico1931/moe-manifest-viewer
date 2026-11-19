import { Injectable } from '@angular/core';
import { ManifestLineObject, ViewerState } from '../../shared';
import { REFERENCE_LADDERS } from '../../shared/data/reference-ladders';
import { HlsValidationService } from '../../shared/services/hls-validation.service';
import { LoggerService } from '../../shared/services/logger.service';
import { RequestLogService } from '../../shared/services/request-log.service';
import { DeviceProfileService } from '../device-profile/device-profile.service';
import { readRendition } from '../single-bitrate-select/single-bitrate.logic';
import { DEFAULT_REFERENCE_NAMES } from '../../shared/data/reference-ladders';
import { buildReport, renderReportHtml, Report, reportFileName } from './session-report.logic';

const { version: appVersion } = require('./../../../../package.json');
/** Chrome refuses very long data: URLs on anchors; stay well under its ~2 MB limit. */
const MAX_DATA_URL_CHARS = 1900000;

export interface ReportSource {
  viewerState: ViewerState;
  requestLog?: RequestLogService;
  manifestUrl: string;
  params?: string;
  manifest?: ManifestLineObject[];
}

export type ExportResult = 'downloaded' | 'copied' | 'failed';

/** Gathers the viewer's state into a report and hands it to the browser as a file. Stateless, so root-provided. */
@Injectable({ providedIn: 'root' })
export class SessionReportService {
  constructor(private logger: LoggerService, private validation: HlsValidationService, private deviceProfiles: DeviceProfileService) {}

  public build(source: ReportSource): Report {
    const { viewerState: vs, requestLog } = source;
    const profile = this.deviceProfiles.get(vs.id);
    const track = vs.selectedAudioTrack;
    return buildReport({
      now: new Date(),
      appVersion,
      userAgent: navigator.userAgent,
      manifestUrl: source.manifestUrl,
      records: requestLog ? requestLog.records : [],
      declaredLevels: requestLog ? requestLog.declaredLevels : [],
      sessionStart: requestLog?.sessionStart,
      references: REFERENCE_LADDERS.filter((r) => DEFAULT_REFERENCE_NAMES.indexOf(r.name) >= 0),
      lintIssues: this.lint(source.manifest),
      videoErrors: (vs.videoErrors || []).map((m) => m.text),
      logs: this.logger.logs,
      deviceProfile: profile && {
        id: profile.id,
        label: profile.label,
        maxHeight: profile.maxHeight,
        bandwidthMbps: profile.bandwidthMbps,
        latencyMs: profile.latencyMs,
      },
      audioTrack: track ? [track.name, track.lang].filter((x) => !!x).join(' / ') : undefined,
      singleBitrateKey: readRendition(source.params || ''),
      playerState: vs.playerState,
    });
  }

  /** Downloads the report. data: URLs are used because the page's CSP forbids blob:. */
  public export(source: ReportSource, format: 'html' | 'json'): ExportResult {
    const report = this.build(source);
    const text = format === 'html' ? renderReportHtml(report) : JSON.stringify(report, null, 2);
    const url = `data:${format === 'html' ? 'text/html' : 'application/json'};charset=utf-8,${encodeURIComponent(text)}`;
    if (url.length <= MAX_DATA_URL_CHARS) {
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = reportFileName(report, format);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return 'downloaded';
      } catch (err) {
        // fall through to the clipboard
      }
    }
    return this.copyJson(report);
  }

  private copyJson(report: Report): ExportResult {
    const area = document.createElement('textarea');
    area.value = JSON.stringify(report, null, 2);
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand('copy') ? 'copied' : 'failed';
    } catch (err) {
      return 'failed';
    } finally {
      document.body.removeChild(area);
    }
  }

  private lint(manifest?: ManifestLineObject[]) {
    const text = (manifest || []).map((l) => l.str).join('\n');
    if (!text.startsWith('#EXTM3U')) {
      return [];
    }
    const isMedia = text.indexOf('#EXT-X-STREAM-INF') < 0;
    return this.validation.validateManifest(text, isMedia).issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message }));
  }
}
