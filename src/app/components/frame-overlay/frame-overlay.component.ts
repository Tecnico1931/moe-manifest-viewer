import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { FrameAnalyzerService, FrameAnalysisResult, ViewerState } from '../../shared';

@Component({
  selector: 'app-frame-overlay',
  templateUrl: './frame-overlay.component.html',
  styleUrls: ['./frame-overlay.component.scss'],
})
export class FrameOverlayComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;
  @Input() public segmentUrl: string;

  public frameData: FrameAnalysisResult | null = null;
  public isAnalyzing = false;
  public errorMessage: string | null = null;
  public showDetails = false;

  private ngUnsubscribe: Subject<void> = new Subject<void>();

  constructor(private frameAnalyzerService: FrameAnalyzerService) {}

  ngOnInit() {
    this.frameAnalyzerService.isAnalyzing.pipe(takeUntil(this.ngUnsubscribe)).subscribe((analyzing) => {
      this.isAnalyzing = analyzing;
    });

    this.frameAnalyzerService.errors.pipe(takeUntil(this.ngUnsubscribe)).subscribe((error) => {
      this.errorMessage = error;
    });
  }

  ngOnDestroy() {
    this.ngUnsubscribe.next();
    this.frameAnalyzerService.reset();
  }

  public async analyzeSegment() {
    if (!this.segmentUrl) {
      this.errorMessage = 'No segment URL provided. Please load a manifest with video segments first.';
      return;
    }

    this.errorMessage = null;
    this.frameData = null;

    try {
      console.log('Fetching segment:', this.segmentUrl);
      const response = await fetch(this.segmentUrl, {
        credentials: this.viewerState.xhrCredentials ? 'include' : 'same-origin',
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch segment: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      console.log('Segment fetched, size:', arrayBuffer.byteLength);

      const observable = await this.frameAnalyzerService.analyzeSegment(arrayBuffer);
      observable.pipe(takeUntil(this.ngUnsubscribe)).subscribe(
        (result) => {
          console.log('Analysis complete:', result);
          this.frameData = result;
        },
        (error) => {
          console.error('Analysis error:', error);
          this.errorMessage = `Analysis failed: ${error.message || 'Unknown error'}`;
        }
      );
    } catch (error) {
      console.error('Fetch error:', error);
      this.errorMessage = `Failed to fetch segment: ${error.message || 'Unknown error'}`;
    }
  }

  public toggleDetails() {
    this.showDetails = !this.showDetails;
  }

  public getFramePercentage(index: number): number {
    if (!this.frameData || this.frameData.totalFrames === 0) {
      return 0;
    }
    return (index / this.frameData.totalFrames) * 100;
  }

  public getFrameWidth(): number {
    if (!this.frameData || this.frameData.totalFrames === 0) {
      return 0;
    }
    return 100 / this.frameData.totalFrames;
  }

  public formatTime(ms: number): string {
    const seconds = ms / 1000;
    return seconds.toFixed(3) + 's';
  }

  public formatSize(bytes: number): string {
    if (bytes < 1024) {
      return bytes + ' B';
    } else if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(2) + ' KB';
    } else {
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }
  }
}
