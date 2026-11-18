import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { asyncScheduler, Subject } from 'rxjs';
import { takeUntil, throttleTime } from 'rxjs/operators';
import { ViewerState } from '../../shared';
import { RequestLogService } from '../../shared/services/request-log.service';
import { AuditResult, buildAudit, toTsv } from './bitrate-audit.logic';

@Component({
  selector: 'app-bitrate-audit',
  templateUrl: './bitrate-audit.component.html',
  styleUrls: ['./bitrate-audit.component.scss'],
})
export class BitrateAuditComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public result: AuditResult = { video: [], audio: [] };
  public copyLabel = 'Copy as TSV';
  public readonly tsTooltip = 'TS segment bytes include roughly 4-10% mux overhead (PAT/PMT, PES and TS headers). Shown uncorrected.';

  private readonly destroy$ = new Subject<void>();

  constructor(private requestLog: RequestLogService) {}

  public ngOnInit(): void {
    this.requestLog.records$
      .pipe(throttleTime(1000, asyncScheduler, { leading: true, trailing: true }), takeUntil(this.destroy$))
      .subscribe((records) => (this.result = buildAudit(records)));
  }

  public ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  public copyTsv(): void {
    const text = toTsv(this.result);
    const done = () => this.flashCopyLabel('Copied');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => this.fallbackCopy(text, done));
    } else {
      this.fallbackCopy(text, done);
    }
  }

  public fmt(n: number | undefined, digits = 0): string {
    return n === undefined ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  public trackLevel(_index: number, row: { level?: number }): number | undefined {
    return row.level;
  }

  private fallbackCopy(text: string, done: () => void): void {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      this.flashCopyLabel('Copy failed');
    }
    document.body.removeChild(area);
  }

  private flashCopyLabel(label: string): void {
    this.copyLabel = label;
    setTimeout(() => (this.copyLabel = 'Copy as TSV'), 1500);
  }
}
