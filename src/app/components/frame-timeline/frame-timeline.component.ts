import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { FrameAnalyzerService, FrameAnalysisResult, FrameInfo, ViewerState } from '../../shared';

@Component({
  selector: 'app-frame-timeline',
  templateUrl: './frame-timeline.component.html',
  styleUrls: ['./frame-timeline.component.scss'],
})
export class FrameTimelineComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;
  @Input() public segmentUrl: string;

  public frameData: FrameAnalysisResult | null = null;
  public currentTime: number = 0;
  public currentFrameIndex: number = -1;

  private ngUnsubscribe: Subject<void> = new Subject<void>();

  constructor(private frameAnalyzerService: FrameAnalyzerService) {}

  ngOnInit() {
    // Subscribe to frame data from the analyzer service
    this.frameAnalyzerService.currentFrameData.pipe(takeUntil(this.ngUnsubscribe)).subscribe((data) => {
      this.frameData = data;
      this.updateCurrentFrame();
    });

    // Subscribe to current time updates
    if (this.viewerState) {
      this.viewerState.currentDisplayTime$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((time) => {
        this.currentTime = time * 1000; // Convert to milliseconds
        this.updateCurrentFrame();
      });
    }
  }

  ngOnDestroy() {
    this.ngUnsubscribe.next();
  }

  private updateCurrentFrame() {
    if (!this.frameData || this.frameData.frames.length === 0) {
      this.currentFrameIndex = -1;
      return;
    }

    // Find the frame that contains the current playback time
    for (let i = 0; i < this.frameData.frames.length; i++) {
      const frame = this.frameData.frames[i];
      if (frame.pts <= this.currentTime && frame.pts + frame.duration > this.currentTime) {
        this.currentFrameIndex = i;
        return;
      }
    }

    // If no exact match, find the closest frame
    this.currentFrameIndex = this.findClosestFrameIndex(this.currentTime);
  }

  private findClosestFrameIndex(time: number): number {
    if (!this.frameData || this.frameData.frames.length === 0) {
      return -1;
    }

    let closestIndex = 0;
    let minDiff = Math.abs(this.frameData.frames[0].pts - time);

    for (let i = 1; i < this.frameData.frames.length; i++) {
      const diff = Math.abs(this.frameData.frames[i].pts - time);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  public getFramePosition(index: number): number {
    if (!this.frameData || this.frameData.frames.length === 0 || this.frameData.duration === 0) {
      return 0;
    }

    const frame = this.frameData.frames[index];
    return (frame.pts / this.frameData.duration) * 100;
  }

  public getFrameWidth(): number {
    if (!this.frameData || this.frameData.frames.length === 0) {
      return 0;
    }
    return 100 / this.frameData.frames.length;
  }

  public getCurrentPlayheadPosition(): number {
    if (!this.frameData || this.frameData.duration === 0) {
      return 0;
    }
    return (this.currentTime / this.frameData.duration) * 100;
  }

  public onTimelineClick(event: MouseEvent) {
    if (!this.frameData || !this.viewerState.videoElement) {
      return;
    }

    const timeline = event.currentTarget as HTMLElement;
    const rect = timeline.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const percentage = (clickX / rect.width) * 100;
    const targetTime = (percentage / 100) * this.frameData.duration;

    // Seek video to target time (convert ms to seconds)
    this.viewerState.updateTime(targetTime / 1000);
    console.log('Seeking to time:', targetTime / 1000, 'seconds');
  }

  public formatTime(ms: number): string {
    const seconds = ms / 1000;
    return seconds.toFixed(3) + 's';
  }
}
