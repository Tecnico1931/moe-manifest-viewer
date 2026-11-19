import { ChangeDetectorRef, Component, Input, OnDestroy, OnInit, Optional } from '@angular/core';
import { Subscription } from 'rxjs';
import { DataService, ParserService, ViewerState } from '../../shared';
import { RequestLogService } from '../../shared/services/request-log.service';
import { buildAudit, VideoRow } from '../bitrate-audit/bitrate-audit.logic';
import {
  alignByHeight,
  audioSummary,
  CmpLadder,
  CmpRow,
  CmpRung,
  CmpTotals,
  deliveredKbps,
  deltaPct,
  firstSegments,
  measuredKbps,
  parseMaster,
  resolveUri,
  totals,
} from './compare.logic';

const MEASURE_SEGMENTS = 3;

interface LoadError {
  side: 'A' | 'B';
  message: string;
}

@Component({
  selector: 'app-compare',
  templateUrl: './compare.component.html',
  styleUrls: ['./compare.component.scss'],
})
export class CompareComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public urlB = '';
  public a?: CmpLadder;
  public b?: CmpLadder;
  public rows: CmpRow[] = [];
  public totalsA: CmpTotals = totals([]);
  public totalsB: CmpTotals = totals([]);
  public audioA = '';
  public audioB = '';
  public error?: LoadError;
  public isLoading = false;
  public isMeasuring = false;
  public hasAuditA = false;
  /** Measured delivered kbps for B rungs, keyed by variant URI. */
  public measuredB: { [uri: string]: number | undefined } = {};

  private auditRows: VideoRow[] = [];
  private sub?: Subscription;
  private masterUrlA?: string;
  private masterUrlB?: string;

  public constructor(
    private dataService: DataService,
    private parserService: ParserService,
    private cdr: ChangeDetectorRef,
    @Optional() private requestLog: RequestLogService
  ) {}

  public ngOnInit(): void {
    this.sub = this.requestLog?.records$.subscribe((records) => {
      this.auditRows = buildAudit(records).video;
      this.hasAuditA = this.auditRows.some((r) => r.avgKbps !== undefined);
      if (!this.masterUrlA) {
        const master = records.filter((r) => r.kind === 'master').sort((x, y) => x.tRequest - y.tRequest)[0];
        this.masterUrlA = master?.url;
      }
      this.cdr.markForCheck();
    });
  }

  public ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  public get canCompare(): boolean {
    return !!this.urlB.trim() && !this.isLoading;
  }

  public get canMeasure(): boolean {
    return !!this.b && !!this.masterUrlB && !this.isMeasuring;
  }

  public async compare(): Promise<void> {
    const urlA = this.masterUrlA || this.viewerState.url;
    this.isLoading = true;
    this.error = undefined;
    this.measuredB = {};
    try {
      this.masterUrlB = this.urlB.trim();
      const [a, b] = await Promise.all([this.loadLadder(urlA, 'A'), this.loadLadder(this.masterUrlB, 'B')]);
      this.a = a;
      this.b = b;
      this.rows = alignByHeight(a.rungs, b.rungs);
      this.totalsA = totals(a.rungs);
      this.totalsB = totals(b.rungs);
      this.audioA = audioSummary(a.audio);
      this.audioB = audioSummary(b.audio);
    } catch (e) {
      this.error = e as LoadError;
    }
    this.isLoading = false;
    this.cdr.markForCheck();
  }

  /** Fetches the first segments of each B rung and estimates delivered bitrate (bytes * 8 / duration). */
  public async measureB(): Promise<void> {
    if (!this.b || !this.masterUrlB) {
      return;
    }
    this.isMeasuring = true;
    this.measuredB = {};
    for (const rung of this.b.rungs) {
      if (!rung.uri) {
        continue;
      }
      this.measuredB = { ...this.measuredB, [rung.uri]: await this.measureRung(rung, this.masterUrlB) };
      this.cdr.markForCheck();
    }
    this.isMeasuring = false;
    this.cdr.markForCheck();
  }

  public deliveredA(rung?: CmpRung): number | undefined {
    return deliveredKbps(rung, this.auditRows);
  }

  public deliveredB(rung?: CmpRung): number | undefined {
    return rung && rung.uri ? this.measuredB[rung.uri] : undefined;
  }

  public deliveredDelta(row: CmpRow): number | undefined {
    return deltaPct(this.deliveredA(row.a), this.deliveredB(row.b));
  }

  public kbps(bps?: number): string {
    return bps ? String(Math.round(bps / 1000)) : '—';
  }

  public kbpsRaw(kbps?: number): string {
    return kbps === undefined ? '—' : String(Math.round(kbps));
  }

  public pct(v?: number): string {
    return v === undefined ? '' : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;
  }

  public res(rung?: CmpRung): string {
    return rung ? `${rung.width}x${rung.height}` : '—';
  }

  public tone(v?: number): string {
    return v === undefined || v === 0 ? '' : v < 0 ? 'neg' : 'pos';
  }

  public trackByIndex(i: number): number {
    return i;
  }

  public totalsDelta(field: 'sumAvg' | 'sumBandwidth' | 'count'): number | undefined {
    return deltaPct(this.totalsA[field], this.totalsB[field]);
  }

  private get requestOptions(): RequestInit | undefined {
    return this.viewerState.xhrCredentials || this.viewerState.globalTokenActive ? { credentials: 'include' } : undefined;
  }

  private async loadLadder(url: string | undefined, side: 'A' | 'B'): Promise<CmpLadder> {
    if (!url) {
      throw { side, message: 'No master playlist loaded for A. Load a manifest first.' } as LoadError;
    }
    try {
      const response = await this.dataService.getManifest(url, this.requestOptions);
      if (this.parserService.getManifestType(response.text || '') !== 'hls') {
        throw new Error('Not an HLS playlist');
      }
      const ladder = parseMaster(response.text || '');
      if (!ladder.rungs.length) {
        throw new Error('No EXT-X-STREAM-INF variants found (is this a master playlist?)');
      }
      return ladder;
    } catch (e) {
      const detail = (e && ((e as { statusText?: string }).statusText || (e as Error).message)) || 'request failed';
      throw { side, message: `Could not load ${side}: ${detail}` } as LoadError;
    }
  }

  private async measureRung(rung: CmpRung, masterUrl: string): Promise<number | undefined> {
    try {
      const playlistUrl = resolveUri(rung.uri as string, masterUrl);
      const playlist = await this.dataService.getManifest(playlistUrl, this.requestOptions);
      const segments = firstSegments(playlist.text || '', playlistUrl, MEASURE_SEGMENTS);
      const sizes = await Promise.all(
        segments.map((s) =>
          fetch(s.url, { ...this.requestOptions, cache: 'no-store' }).then((res) =>
            res.ok ? res.arrayBuffer().then((buf) => buf.byteLength) : 0
          )
        )
      );
      return segments.length && sizes.every((n) => n > 0)
        ? measuredKbps(sizes, segments.map((s) => s.duration))
        : undefined;
    } catch (e) {
      return undefined;
    }
  }
}
