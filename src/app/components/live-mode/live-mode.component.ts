import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { interval, Subscription } from 'rxjs';
import { ViewerState } from '../../shared';
import { RequestLogService } from '../../shared/services/request-log.service';
import {
  analyzeReloads,
  evaluateFlags,
  FragmentLike,
  joinTimeMs,
  LatencySample,
  latencySec,
  LiveAnalysis,
  LiveFlag,
  playheadPdtMs,
  ReloadRow,
  sparklinePoints,
} from './live-mode.logic';

const SAMPLE_EVERY_MS = 1000;
const MAX_SAMPLES = 600;
const TABLE_ROWS = 12;
const SPARK_W = 360;
const SPARK_H = 48;

@Component({
  selector: 'app-live-mode',
  templateUrl: './live-mode.component.html',
  styleUrls: ['./live-mode.component.scss'],
})
export class LiveModeComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public analysis: LiveAnalysis = analyzeReloads([], 0);
  public flags: LiveFlag[] = [];
  public samples: LatencySample[] = [];
  public latencySec?: number;
  public joinMs?: number;
  public readonly sparkW = SPARK_W;
  public readonly sparkH = SPARK_H;

  private subscriptions = new Subscription();
  private fragments: FragmentLike[] = [];
  private video?: HTMLVideoElement;
  private firstFramePerf?: number;
  private sessionStart?: number;

  constructor(private requestLog: RequestLogService) {}

  public ngOnInit(): void {
    this.subscriptions.add(this.requestLog.records$.subscribe(() => this.recompute()));
    this.subscriptions.add(this.viewerState.fragments$.subscribe((frags) => (this.fragments = frags || [])));
    this.subscriptions.add(interval(SAMPLE_EVERY_MS).subscribe(() => this.sample()));
  }

  public ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.detachVideo();
  }

  public get flagIds(): string[] {
    return this.flags.map((f) => f.id);
  }

  public get isVod(): boolean {
    return this.analysis.isLive === false;
  }

  public get hasPlaylist(): boolean {
    return this.analysis.isLive !== undefined;
  }

  public get sparkline(): string {
    return sparklinePoints(this.samples, SPARK_W, SPARK_H);
  }

  public get maxLatency(): number {
    return Math.max(0, ...this.samples.map((s) => s.latencySec));
  }

  public get tableRows(): ReloadRow[] {
    return this.analysis.rows.slice(-TABLE_ROWS).reverse();
  }

  public sec(value?: number, digits = 1): string {
    return value === undefined ? '—' : value.toFixed(digits) + ' s';
  }

  public msAsSec(value?: number): string {
    return value === undefined ? '—' : (value / 1000).toFixed(1) + ' s';
  }

  public rowAge(row: ReloadRow): string {
    return this.sec(row.availabilityLagSec);
  }

  private wallOffset(): number {
    return Date.now() - performance.now();
  }

  private recompute(): void {
    const start = this.requestLog.sessionStart;
    if (start !== this.sessionStart) {
      // new manifest: forget the previous stream's history
      this.sessionStart = start;
      this.samples = [];
      this.firstFramePerf = undefined;
    }
    this.attachVideo();
    this.analysis = analyzeReloads(this.requestLog.records, this.wallOffset());
    const earliest = (m: number | undefined, r: { tRequest: number }) => (m === undefined || r.tRequest < m ? r.tRequest : m);
    const first = start ?? this.requestLog.records.reduce<number | undefined>(earliest, undefined);
    this.joinMs = joinTimeMs(first, this.firstFramePerf);
    this.flags = evaluateFlags(this.analysis, this.latencySec);
  }

  private sample(): void {
    this.attachVideo();
    if (!this.video || this.analysis.isLive !== true || this.video.paused) {
      return;
    }
    const value = latencySec(playheadPdtMs(this.fragments, this.video.currentTime), Date.now());
    if (value === undefined) {
      return;
    }
    this.latencySec = value;
    this.samples = [...this.samples, { t: performance.now(), latencySec: value }].slice(-MAX_SAMPLES);
    this.flags = evaluateFlags(this.analysis, value);
  }

  /** Best effort, like the startup panel: finds this viewer's <video> so no player internals are touched. */
  private attachVideo(): void {
    const video = this.viewerState.videoElement;
    if (!video || video === this.video) {
      return;
    }
    this.detachVideo();
    this.video = video;
    video.addEventListener('playing', this.onFrame);
  }

  private detachVideo(): void {
    this.video?.removeEventListener('playing', this.onFrame);
    this.video = undefined;
  }

  private onFrame = (): void => {
    if (this.firstFramePerf === undefined) {
      this.firstFramePerf = performance.now();
      this.recompute();
    }
  };
}
