import { Component, OnInit, Input, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { ParsedManifest, ViewerState } from '../../shared';
import { HlsValidationService } from '../../shared/services/hls-validation.service';
import { HlsIssue, HlsValidationResult, HlsIssueSeverity } from '../../shared/models/hls-issue.model';

@Component({
  selector: 'app-hls-issues',
  templateUrl: './hls-issues.component.html',
  styleUrls: ['./hls-issues.component.scss'],
})
export class HlsIssuesComponent implements OnInit, OnDestroy {
  @Input() public manifestUpdate$: BehaviorSubject<ParsedManifest | null>;
  @Input() public viewerReset$: Subject<void>;
  @Input() public viewerState: ViewerState;

  public validationResult: HlsValidationResult | null = null;
  public isExpanded = true;
  public filterSeverity: HlsIssueSeverity | 'all' = 'all';
  public filteredIssues: HlsIssue[] = [];
  public lastValidatedUrl = '';

  private ngUnsubscribe: Subject<void> = new Subject<void>();

  constructor(private hlsValidationService: HlsValidationService) {}

  public ngOnInit(): void {
    this.manifestUpdate$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.onManifestUpdate);
    this.viewerReset$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.onViewerReset);

    // Subscribe to HLS player errors
    if (this.viewerState) {
      this.viewerState.hlsError$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.onHlsError);
    }
  }

  public ngOnDestroy(): void {
    this.ngUnsubscribe.next();
  }

  public onManifestUpdate = (manifest: ParsedManifest | null): void => {
    if (manifest && manifest.manifest) {
      this.lastValidatedUrl = manifest.url;
      const isMediaPlaylist = manifest.info?.level === 'stream';
      this.validationResult = this.hlsValidationService.validateManifest(manifest.manifest, isMediaPlaylist);
      this.applyFilter();
    }
  };

  public onViewerReset = (): void => {
    this.validationResult = null;
    this.filteredIssues = [];
    this.lastValidatedUrl = '';
  };

  public onHlsError = (error: any): void => {
    if (error && this.validationResult) {
      const playerIssues = this.hlsValidationService.validateFromPlayerError(
        error.type,
        error.details,
        undefined
      );

      // Add player errors to existing issues (avoiding duplicates)
      const existingCodes = new Set(this.validationResult.issues.map((i) => i.code + i.message));
      const newIssues = playerIssues.filter((i) => !existingCodes.has(i.code + i.message));

      if (newIssues.length > 0) {
        this.validationResult = {
          ...this.validationResult,
          issues: [...this.validationResult.issues, ...newIssues],
          summary: {
            errors: this.validationResult.summary.errors + newIssues.filter((i) => i.severity === 'error').length,
            warnings: this.validationResult.summary.warnings + newIssues.filter((i) => i.severity === 'warning').length,
            info: this.validationResult.summary.info + newIssues.filter((i) => i.severity === 'info').length,
          },
        };
        this.applyFilter();
      }
    }
  };

  public toggleExpand(): void {
    this.isExpanded = !this.isExpanded;
  }

  public setFilter(severity: HlsIssueSeverity | 'all'): void {
    this.filterSeverity = severity;
    this.applyFilter();
  }

  public revalidate(): void {
    const currentManifest = this.manifestUpdate$.getValue();
    if (currentManifest) {
      this.onManifestUpdate(currentManifest);
    }
  }

  private applyFilter(): void {
    if (!this.validationResult) {
      this.filteredIssues = [];
      return;
    }

    if (this.filterSeverity === 'all') {
      this.filteredIssues = this.validationResult.issues;
    } else {
      this.filteredIssues = this.validationResult.issues.filter((i) => i.severity === this.filterSeverity);
    }
  }

  public getSeverityIcon(severity: HlsIssueSeverity): string {
    switch (severity) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      case 'info':
        return 'info';
      default:
        return 'help';
    }
  }

  public getCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
      structure: 'Structure',
      'required-tag': 'Required Tag',
      duration: 'Duration',
      'master-playlist': 'Master Playlist',
      'media-playlist': 'Media Playlist',
      compatibility: 'Compatibility',
      'best-practice': 'Best Practice',
    };
    return labels[category] || category;
  }
}
