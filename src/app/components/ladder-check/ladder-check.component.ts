import { ChangeDetectorRef, Component, Input, OnDestroy, OnInit, Optional } from '@angular/core';
import { Subscription } from 'rxjs';
import { ViewerState } from '../../shared';
import { RequestLogService, RequestRecord } from '../../shared/services/request-log.service';
import { DEFAULT_REFERENCE_NAMES, REFERENCE_LADDERS, ReferenceLadder } from '../../shared/data/reference-ladders';
import {
  bitsPerPixel,
  Check,
  DEFAULT_FPS,
  formatKbps,
  interpolateAtHeight,
  logTicks,
  parseMasterLadder,
  percentDiff,
  runChecks,
  Rung,
  rungsFromLevels,
  stepRatios,
} from './ladder-check.logic';

const MAX_REFERENCES = 3;
const CURRENT_COLOR = '#e8590c';
const REFERENCE_COLORS = ['#1c7ed6', '#2f9e44', '#9c36b5'];

const W = 560;
const H = 260;
const PAD = { left: 46, right: 14, top: 12, bottom: 30 };

interface RefCell {
  bps: number | null;
  diff: number | null;
}

interface Row {
  rung: Rung;
  fps: number;
  isFpsAssumed: boolean;
  bpp: number;
  step: number | null;
  refs: RefCell[];
}

@Component({
  selector: 'app-ladder-check',
  templateUrl: './ladder-check.component.html',
  styleUrls: ['./ladder-check.component.scss'],
})
export class LadderCheckComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public readonly references = REFERENCE_LADDERS;
  public readonly maxReferences = MAX_REFERENCES;
  public readonly currentColor = CURRENT_COLOR;
  public readonly width = W;
  public readonly height = H;
  public readonly pad = PAD;
  public selected: string[] = REFERENCE_LADDERS.filter((r) => DEFAULT_REFERENCE_NAMES.indexOf(r.name) >= 0).map((r) => r.name);
  public isPickerOpen = false;
  public current: Rung[] = [];
  public rows: Row[] = [];
  public checks: Check[] = [];
  public ticksX: { x: number; label: string }[] = [];
  public ticksY: { y: number; label: string }[] = [];
  public currentSource = '';

  private sub?: Subscription;
  private masterUrl?: string;
  private masterRequested?: string;

  public constructor(@Optional() private requestLog: RequestLogService, private cdr: ChangeDetectorRef) {}

  public ngOnInit(): void {
    this.sub = this.requestLog?.records$.subscribe((records) => this.onRecords(records));
  }

  public ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  public get selectedRefs(): ReferenceLadder[] {
    return this.selected.map((name) => this.references.find((r) => r.name === name)).filter((r): r is ReferenceLadder => !!r);
  }

  public colorOf(name: string): string {
    const i = this.selected.indexOf(name);
    return i >= 0 ? REFERENCE_COLORS[i] : '#adb5bd';
  }

  public isSelected(name: string): boolean {
    return this.selected.indexOf(name) >= 0;
  }

  public isDisabled(name: string): boolean {
    return !this.isSelected(name) && this.selected.length >= MAX_REFERENCES;
  }

  public toggleReference(name: string): void {
    if (this.isSelected(name)) {
      this.selected = this.selected.filter((n) => n !== name);
    } else if (this.selected.length < MAX_REFERENCES) {
      this.selected = [...this.selected, name];
    }
    this.recompute();
  }

  public sourceLabel(ref: ReferenceLadder): string {
    const s = ref.source;
    return s ? [s.text, s.url, s.date].filter((x) => !!x).join(' | ') : '';
  }

  public x(bps: number): number {
    const [lo, hi] = this.xRange();
    return PAD.left + ((Math.log(bps) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - PAD.left - PAD.right);
  }

  public y(height: number): number {
    const [lo, hi] = this.yRange();
    return H - PAD.bottom - ((height - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  }

  /** Step polyline for a ladder given as [bps, height] points sorted by bitrate. */
  public path(points: { bps: number; height: number }[]): string {
    return points.map((p, i) => `${i ? 'L' : 'M'}${this.x(p.bps).toFixed(1)},${this.y(p.height).toFixed(1)}`).join(' ');
  }

  public refPoints(ref: ReferenceLadder): { bps: number; height: number }[] {
    return ref.ladder.map(([, height, bps]) => ({ bps, height })).sort((a, b) => a.bps - b.bps);
  }

  public currentPoints(): { bps: number; height: number }[] {
    return this.current.map((r) => ({ bps: r.peak, height: r.height }));
  }

  public avgPoints(): { bps: number; height: number }[] {
    return this.current.filter((r) => !!r.avg).map((r) => ({ bps: r.avg as number, height: r.height }));
  }

  public kbps(bps: number | undefined): string {
    return bps ? String(Math.round(bps / 1000)) : '—';
  }

  public pct(diff: number | null): string {
    return diff === null ? '' : `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%`;
  }

  public trackByIndex(i: number): number {
    return i;
  }

  private allBitrates(): number[] {
    const cur = this.current.reduce<number[]>((acc, r) => [...acc, r.peak, ...(r.avg ? [r.avg] : [])], []);
    const refs = this.selectedRefs.reduce<number[]>((acc, r) => [...acc, ...r.ladder.map((l) => l[2])], []);
    return [...cur, ...refs];
  }

  private xRange(): [number, number] {
    const all = this.allBitrates();
    const ticks = logTicks(Math.min(...all), Math.max(...all));
    return [ticks[0], ticks[ticks.length - 1]];
  }

  private yRange(): [number, number] {
    const heights = [
      ...this.current.map((r) => r.height),
      ...this.selectedRefs.reduce<number[]>((acc, r) => [...acc, ...r.ladder.map((l) => l[1])], []),
    ];
    const hi = Math.max(...heights);
    return [0, Math.ceil(hi / 360) * 360];
  }

  private onRecords(records: RequestRecord[]): void {
    const byLevel = new Map<number, RequestRecord>();
    records.filter((r) => r.level !== undefined && r.bandwidthDeclared && r.resolution).forEach((r) => byLevel.set(r.level as number, r));
    const fromRecords = rungsFromLevels(
      Array.from(byLevel.values()).map((r) => ({
        bandwidth: r.bandwidthDeclared,
        averageBandwidth: r.averageBandwidthDeclared,
        resolution: r.resolution,
      }))
    );
    if (fromRecords.length > this.current.length) {
      this.current = fromRecords;
      this.currentSource = 'requested variants';
      this.recompute();
    }
    // The log only has rungs the player requested; the master playlist has the full ladder (and FRAME-RATE).
    const master = records.filter((r) => r.kind === 'master').sort((a, b) => a.tRequest - b.tRequest)[0];
    if (master && master.url !== this.masterRequested) {
      this.masterRequested = master.url;
      this.loadMaster(master.url);
    }
  }

  private loadMaster(url: string): void {
    fetch(url)
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        const rungs = parseMasterLadder(text);
        if (rungs.length && this.masterRequested === url) {
          this.current = rungs;
          this.currentSource = 'master playlist';
          this.recompute();
          this.cdr.markForCheck();
        }
      })
      .catch(() => undefined);
  }

  private recompute(): void {
    const refs = this.selectedRefs;
    const ratios = stepRatios(this.current);
    this.rows = this.current.map((rung, i) => {
      const fps = rung.fps || DEFAULT_FPS;
      return {
        rung,
        fps,
        isFpsAssumed: !rung.fps,
        bpp: bitsPerPixel(rung.avg || rung.peak, rung.width, rung.height, fps),
        step: ratios[i],
        refs: refs.map((ref) => {
          const bps = interpolateAtHeight(ref.ladder, rung.height);
          return { bps, diff: percentDiff(rung.peak, bps) };
        }),
      };
    });
    this.checks = runChecks(this.current, refs);
    if (this.current.length) {
      this.ticksX = logTicks(...this.xRange()).map((t) => ({ x: this.x(t), label: formatKbps(t) }));
      const [, top] = this.yRange();
      this.ticksY = [0, 1, 2, 3, 4, 5].map((n) => (n * top) / 5).map((h) => ({ y: this.y(h), label: String(Math.round(h)) }));
    }
  }
}
