import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { FrameAnalyzerService, FrameAnalysisResult, FrameInfo, ViewerState, formatTimeMs } from '../../shared';

@Component({
  selector: 'app-frame-timeline',
  templateUrl: './frame-timeline.component.html',
  styleUrls: ['./frame-timeline.component.scss'],
})
export class FrameTimelineComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;
  @Input() public segmentUrl: string;

  public frameData: FrameAnalysisResult | null = null;
  public currentTime = 0;
  public currentFrameIndex = -1;
  public isFullscreen = false;

  private ngUnsubscribe: Subject<void> = new Subject<void>();

  constructor(private frameAnalyzerService: FrameAnalyzerService) {}

  public ngOnInit() {
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

  public ngOnDestroy() {
    this.ngUnsubscribe.next();
    // Remove keyboard event listener if it exists
    if (this.isFullscreen) {
      document.removeEventListener('keydown', this.handleKeydown);
    }
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
  }

  public formatTime = formatTimeMs;

  public previousFrame() {
    if (!this.frameData || this.currentFrameIndex <= 0) {
      return;
    }
    const prevFrame = this.frameData.frames[this.currentFrameIndex - 1];
    this.seekToFrame(prevFrame.pts);
  }

  public nextFrame() {
    if (!this.frameData || this.currentFrameIndex >= this.frameData.frames.length - 1) {
      return;
    }
    const nextFrame = this.frameData.frames[this.currentFrameIndex + 1];
    this.seekToFrame(nextFrame.pts);
  }

  public previousKeyframe() {
    if (!this.frameData || this.currentFrameIndex <= 0) {
      return;
    }

    // Find previous I-frame
    for (let i = this.currentFrameIndex - 1; i >= 0; i--) {
      if (this.frameData.frames[i].isKeyframe) {
        this.seekToFrame(this.frameData.frames[i].pts);
        return;
      }
    }
  }

  public nextKeyframe() {
    if (!this.frameData || this.currentFrameIndex >= this.frameData.frames.length - 1) {
      return;
    }

    // Find next I-frame
    for (let i = this.currentFrameIndex + 1; i < this.frameData.frames.length; i++) {
      if (this.frameData.frames[i].isKeyframe) {
        this.seekToFrame(this.frameData.frames[i].pts);
        return;
      }
    }
  }

  private seekToFrame(pts: number) {
    if (!this.viewerState.videoElement) {
      return;
    }
    // Convert ms to seconds
    this.viewerState.updateTime(pts / 1000);
  }

  public canGoPrevious(): boolean {
    return this.frameData !== null && this.currentFrameIndex > 0;
  }

  public canGoNext(): boolean {
    return this.frameData !== null && this.currentFrameIndex < this.frameData.frames.length - 1;
  }

  public hasPreviousKeyframe(): boolean {
    if (!this.frameData || this.currentFrameIndex <= 0) {
      return false;
    }
    for (let i = this.currentFrameIndex - 1; i >= 0; i--) {
      if (this.frameData.frames[i].isKeyframe) {
        return true;
      }
    }
    return false;
  }

  public hasNextKeyframe(): boolean {
    if (!this.frameData || this.currentFrameIndex >= this.frameData.frames.length - 1) {
      return false;
    }
    for (let i = this.currentFrameIndex + 1; i < this.frameData.frames.length; i++) {
      if (this.frameData.frames[i].isKeyframe) {
        return true;
      }
    }
    return false;
  }

  public toggleFullscreen() {
    this.isFullscreen = !this.isFullscreen;

    if (this.isFullscreen) {
      // Add keyboard event listener for Escape key
      document.addEventListener('keydown', this.handleKeydown);
      // Prevent body scroll when in fullscreen
      document.body.style.overflow = 'hidden';
    } else {
      // Remove keyboard event listener
      document.removeEventListener('keydown', this.handleKeydown);
      // Restore body scroll
      document.body.style.overflow = '';
    }
  }

  private handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.isFullscreen) {
      this.toggleFullscreen();
    } else if (this.frameData) {
      // Keyboard shortcuts for frame navigation
      switch (event.key) {
        case 'ArrowLeft':
          if (event.shiftKey) {
            this.previousKeyframe();
          } else {
            this.previousFrame();
          }
          event.preventDefault();
          break;
        case 'ArrowRight':
          if (event.shiftKey) {
            this.nextKeyframe();
          } else {
            this.nextFrame();
          }
          event.preventDefault();
          break;
      }
    }
  };
}
