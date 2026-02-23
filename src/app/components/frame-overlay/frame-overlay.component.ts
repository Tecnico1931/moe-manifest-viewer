import { Component, OnInit, OnDestroy, OnChanges, Input } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil, debounceTime } from 'rxjs/operators';
import { FrameAnalyzerService, FrameAnalysisResult, ViewerState, CopyService, formatTimeMs, formatSize } from '../../shared';

@Component({
  selector: 'app-frame-overlay',
  templateUrl: './frame-overlay.component.html',
  styleUrls: ['./frame-overlay.component.scss'],
})
export class FrameOverlayComponent implements OnInit, OnDestroy, OnChanges {
  @Input() public viewerState: ViewerState;
  @Input() public segmentUrl: string;

  public frameData: FrameAnalysisResult | null = null;
  public isAnalyzing = false;
  public errorMessage: string | null = null;
  public showDetails = false;
  public autoAnalyzeEnabled = false;
  public lastAnalyzedUrl = '';
  public segmentChangeCount = 0;
  public analysisHistory: Array<{ url: string; timestamp: number; frameCount: number }> = [];

  private ngUnsubscribe: Subject<void> = new Subject<void>();
  private segmentChangeSubject = new Subject<string>();

  constructor(private frameAnalyzerService: FrameAnalyzerService, private copyService: CopyService) {}

  public ngOnInit() {
    this.frameAnalyzerService.isAnalyzing.pipe(takeUntil(this.ngUnsubscribe)).subscribe((analyzing) => {
      this.isAnalyzing = analyzing;
    });

    this.frameAnalyzerService.errors.pipe(takeUntil(this.ngUnsubscribe)).subscribe((error) => {
      this.errorMessage = error;
    });

    // Set up segment change detection with debounce (500ms)
    this.segmentChangeSubject.pipe(debounceTime(500), takeUntil(this.ngUnsubscribe)).subscribe((url) => {
      if (this.autoAnalyzeEnabled && url && url !== this.lastAnalyzedUrl) {
        this.segmentChangeCount++;
        this.analyzeSegment();
      }
    });
  }

  public ngOnChanges(changes: any) {
    // Detect segment URL changes
    if (changes.segmentUrl && changes.segmentUrl.currentValue) {
      const newUrl = changes.segmentUrl.currentValue;
      if (newUrl !== changes.segmentUrl.previousValue) {
        this.segmentChangeSubject.next(newUrl);
      }
    }
  }

  public ngOnDestroy() {
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
      const response = await fetch(this.segmentUrl, {
        credentials: this.viewerState.xhrCredentials ? 'include' : 'same-origin',
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch segment: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const observable = await this.frameAnalyzerService.analyzeSegment(arrayBuffer);
      observable.pipe(takeUntil(this.ngUnsubscribe)).subscribe(
        (result) => {
          this.frameData = result;
          this.lastAnalyzedUrl = this.segmentUrl;

          // Add to history
          this.analysisHistory.unshift({
            url: this.segmentUrl,
            timestamp: Date.now(),
            frameCount: result.totalFrames,
          });

          // Keep only last 10
          if (this.analysisHistory.length > 10) {
            this.analysisHistory = this.analysisHistory.slice(0, 10);
          }
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

  public toggleAutoAnalyze() {
    this.autoAnalyzeEnabled = !this.autoAnalyzeEnabled;
  }

  public exportFrameData() {
    if (!this.frameData) {
      return;
    }

    const exportData = {
      segmentUrl: this.segmentUrl,
      containerType: this.frameData.containerType,
      totalFrames: this.frameData.totalFrames,
      keyframeCount: this.frameData.keyframeCount,
      gopSize: this.frameData.gopSize,
      duration: this.frameData.duration,
      timestamp: new Date().toISOString(),
      frames: this.frameData.frames,
      gopStructure: this.calculateGOPStructure(),
    };

    const jsonString = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `frame-analysis-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  public copyFrameDataToClipboard() {
    if (!this.frameData) {
      return;
    }

    const summary = `Frame Analysis Summary:
Container: ${this.frameData.containerType}
Total Frames: ${this.frameData.totalFrames}
I-Frames: ${this.frameData.keyframeCount}
P/B-Frames: ${this.frameData.totalFrames - this.frameData.keyframeCount}
Average GOP Size: ${this.frameData.gopSize.toFixed(2)}
Duration: ${this.formatTime(this.frameData.duration)}

GOP Structure:
${this.calculateGOPStructure()
  .map((gop, i) => `GOP ${i + 1}: ${gop.size} frames (${gop.duration.toFixed(2)}ms)`)
  .join('\n')}`;

    this.copyService.copyText(summary);
  }

  public calculateGOPStructure(): Array<{ start: number; size: number; duration: number }> {
    if (!this.frameData) {
      return [];
    }

    const gops: Array<{ start: number; size: number; duration: number }> = [];
    let currentGOPStart = 0;
    let currentGOPSize = 0;

    this.frameData.frames.forEach((frame, index) => {
      if (frame.isKeyframe && index > 0) {
        // Calculate duration of previous GOP
        const startFrame = this.frameData!.frames[currentGOPStart];
        const endFrame = this.frameData!.frames[index - 1];
        const duration = endFrame.pts + endFrame.duration - startFrame.pts;

        gops.push({
          start: currentGOPStart,
          size: currentGOPSize,
          duration: duration,
        });

        currentGOPStart = index;
        currentGOPSize = 1;
      } else {
        currentGOPSize++;
      }
    });

    // Add last GOP
    if (currentGOPSize > 0 && this.frameData.frames.length > 0) {
      const startFrame = this.frameData.frames[currentGOPStart];
      const endFrame = this.frameData.frames[this.frameData.frames.length - 1];
      const duration = endFrame.pts + endFrame.duration - startFrame.pts;

      gops.push({
        start: currentGOPStart,
        size: currentGOPSize,
        duration: duration,
      });
    }

    return gops;
  }

  public getFrameRate(): number {
    if (!this.frameData || this.frameData.duration === 0) {
      return 0;
    }
    return (this.frameData.totalFrames / (this.frameData.duration / 1000)).toFixed(2) as any;
  }

  public getBitrate(segmentSizeBytes: number): string {
    if (!this.frameData || this.frameData.duration === 0) {
      return 'N/A';
    }
    const durationSec = this.frameData.duration / 1000;
    const bitrateKbps = (segmentSizeBytes * 8) / durationSec / 1000;
    return bitrateKbps.toFixed(0) + ' kbps';
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

  public formatTime = formatTimeMs;
  public formatSize = formatSize;
}
