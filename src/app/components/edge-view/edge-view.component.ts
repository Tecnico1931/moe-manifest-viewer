import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ViewerState } from '../../shared';
import { RequestLogService, RequestRecord } from '../../shared/services/request-log.service';
import {
  EdgeRow,
  EdgeSummary,
  EXPOSE_HEADERS_VALUE,
  HeaderVisibility,
  PRAGMA_VALUE,
  SingleBitrateResult,
  buildRow,
  detectSingleBitrate,
  filterRows,
  formatBytes,
  headerVisibility,
  orderRows,
  summarize,
} from './edge-view.logic';

@Component({
  selector: 'app-edge-view',
  templateUrl: './edge-view.component.html',
  styleUrls: ['./edge-view.component.scss'],
})
export class EdgeViewComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public rows: EdgeRow[] = [];
  public visibleRows: EdgeRow[] = [];
  public summary: EdgeSummary = summarize([]);
  public singleBitrate: SingleBitrateResult = { isSingle: false, reason: '' };
  public visibility: HeaderVisibility[] = [];
  public missingHeaders: HeaderVisibility[] = [];
  public kinds: string[] = [];
  public kindFilter = 'all';
  public expandedId?: number;
  public readonly exposeHeadersValue = EXPOSE_HEADERS_VALUE;
  public readonly pragmaValue = PRAGMA_VALUE;
  public readonly formatBytes = formatBytes;

  private ngUnsubscribe = new Subject<void>();

  constructor(private requestLog: RequestLogService) {}

  public ngOnInit(): void {
    this.requestLog.records$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.refresh);
  }

  public ngOnDestroy(): void {
    this.ngUnsubscribe.next();
    this.ngUnsubscribe.complete();
  }

  public setFilter(kind: string): void {
    this.kindFilter = kind;
    this.visibleRows = filterRows(this.rows, kind);
  }

  public toggle(row: EdgeRow): void {
    this.expandedId = this.expandedId === row.id ? undefined : row.id;
  }

  public trackById = (_: number, row: EdgeRow): number => row.id;

  public percent = (ratio?: number): string => (ratio === undefined ? '-' : `${Math.round(ratio * 100)}%`);

  public ms = (value?: number): string => (value === undefined ? '-' : `${Math.round(value)} ms`);

  private refresh = (records: RequestRecord[]): void => {
    this.rows = orderRows(records.map(buildRow));
    this.kinds = Array.from(new Set(this.rows.map((r) => r.kind)));
    if (this.kindFilter !== 'all' && !this.kinds.includes(this.kindFilter)) {
      this.kindFilter = 'all';
    }
    this.visibleRows = filterRows(this.rows, this.kindFilter);
    this.summary = summarize(this.rows);
    this.singleBitrate = detectSingleBitrate({ records });
    this.visibility = headerVisibility(records);
    this.missingHeaders = this.visibility.filter((v) => !v.seen);
  };
}
