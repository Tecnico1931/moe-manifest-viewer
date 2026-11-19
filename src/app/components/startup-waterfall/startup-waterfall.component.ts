import { Component, ElementRef, Input, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ViewerState } from '../../shared';
import { RequestLogService } from '../../shared/services/request-log.service';
import { watchFirstFrame, FirstFrameWatch } from './first-frame.capture';
import { computeStartup, firstFrameStatus, firstFrameText, StartupResult, toJson, VideoSnapshot, WaterfallRow } from './startup-waterfall.logic';

const LABEL_WIDTH = 360;
const BAR_AREA = 520;
const ROW_HEIGHT = 20;
const TOP_RUNG_KBYTES_HINT = 'Started on the top rung: first segment is large (live: 1080p, 12 s segments, about 7.7 MB).';

@Component({
  selector: 'app-startup-waterfall',
  templateUrl: './startup-waterfall.component.html',
  styleUrls: ['./startup-waterfall.component.scss'],
})
export class StartupWaterfallComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public result: StartupResult = computeStartup([]);
  public copied = false;
  public readonly labelWidth = LABEL_WIDTH;
  public readonly barArea = BAR_AREA;
  public readonly rowHeight = ROW_HEIGHT;
  public readonly topRungHint = TOP_RUNG_KBYTES_HINT;

  private subscription?: Subscription;
  private frozen = false;
  private frozenStart?: number;
  private firstFramePerf?: number;
  private video?: HTMLVideoElement;
  private watch?: FirstFrameWatch;

  constructor(private requestLog: RequestLogService, private host: ElementRef<HTMLElement>) {}

  public ngOnInit(): void {
    this.subscription = this.requestLog.records$.subscribe(() => this.recompute());
  }

  public ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.detachVideo();
  }

  /** Axis end: the later of the last finished bar and join time, with a little headroom. */
  public get axisMax(): number {
    const ends = this.result.rows.map((row) => row.endMs ?? row.firstByteMs ?? row.startMs);
    return Math.max(100, ...ends, this.result.firstFrameMs ?? 0) * 1.02;
  }

  public get svgHeight(): number {
    return (this.result.rows.length + 1) * ROW_HEIGHT + 4;
  }

  public get ticks(): number[] {
    const max = this.axisMax;
    const step = [50, 100, 250, 500, 1000, 2000, 5000].find((s) => max / s <= 8) || 10000;
    return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  }

  public x(ms: number): number {
    return LABEL_WIDTH + (Math.max(0, ms) / this.axisMax) * BAR_AREA;
  }

  public y(index: number): number {
    return index * ROW_HEIGHT + 2;
  }

  public waitWidth(row: WaterfallRow): number {
    return row.firstByteMs === undefined ? 0 : this.x(row.firstByteMs) - this.x(row.startMs);
  }

  public transferX(row: WaterfallRow): number {
    return row.firstByteMs === undefined ? this.x(row.startMs) : this.x(row.firstByteMs);
  }

  public transferWidth(row: WaterfallRow): number {
    const end = row.endMs ?? row.firstByteMs ?? row.startMs;
    return Math.max(1, this.x(end) - this.transferX(row));
  }

  public rowLabel(row: WaterfallRow): string {
    return [row.label, row.rendition].filter(Boolean).join(' ');
  }

  public get firstFrameLabel(): string {
    return firstFrameText(this.result.firstFrameMs, this.snapshot());
  }

  public get firstFramePending(): boolean {
    return firstFrameStatus(this.result.firstFrameMs, this.snapshot()) !== 'rendered';
  }

  public ms(value?: number): string {
    return value === undefined ? '—' : Math.round(value).toLocaleString() + ' ms';
  }

  public kb(bytes?: number): string {
    return bytes === undefined ? '—' : (bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' KB';
  }

  public rowDetail(row: WaterfallRow): string {
    return `${this.kb(row.bytes)}  ttfb ${this.ms(row.ttfbMs)}  dl ${this.ms(row.downloadMs)}`;
  }

  public copyJson(): void {
    const text = JSON.stringify(toJson(this.result), null, 2);
    const done = () => {
      this.copied = true;
      setTimeout(() => (this.copied = false), 1500);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, () => undefined);
    }
  }

  private recompute(): void {
    const start = this.requestLog.sessionStart;
    this.attachVideo();
    if (this.frozen && start === this.frozenStart) {
      return; // startup is a one-off: keep the frozen numbers until the log is reset
    }
    this.frozen = false;
    const declaredRates = this.requestLog.declaredLevels.filter((l) => !!l.bandwidth).map((l) => l.bandwidth as number);
    this.result = computeStartup(this.requestLog.records, start, this.firstFramePerf, declaredRates);
    if (this.result.isComplete) {
      this.frozen = true;
      this.frozenStart = start;
    }
  }

  private snapshot(): VideoSnapshot {
    const v = this.video;
    return { hasVideo: !!v, paused: !!v?.paused, readyState: v?.readyState ?? 0, hasSource: !!(v && (v.currentSrc || v.src)) };
  }

  /** Best effort: finds this viewer's <video> in the DOM, so no player internals are touched. */
  private attachVideo(): void {
    const video = this.host.nativeElement.closest('app-manifest-viewer')?.querySelector('video');
    if (!video || video === this.video) {
      return;
    }
    this.detachVideo();
    this.video = video;
    this.firstFramePerf = undefined;
    this.watch = watchFirstFrame(video, this.onFrame, this.onVideoChange);
  }

  private detachVideo(): void {
    this.watch?.dispose();
    this.watch = undefined;
    this.video = undefined;
  }

  private onFrame = (perf: number): void => {
    this.firstFramePerf = perf;
    this.frozen = false;
    this.recompute();
  };

  /** The element started a new load (drop the old frame) or changed play state (refresh the label). */
  private onVideoChange = (isNewLoad: boolean): void => {
    if (isNewLoad) {
      this.firstFramePerf = undefined;
    }
    this.frozen = false;
    this.recompute();
  };
}
