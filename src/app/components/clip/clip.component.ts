import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { ViewerState, AudioTrack } from '../../shared';
import { ClipService, ClipState } from '../../shared/services/clip.service';

@Component({
  selector: 'app-clip',
  templateUrl: './clip.component.html',
  styleUrls: ['./clip.component.scss'],
})
export class ClipComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public inPoint = 0;
  public outPoint = 0;
  public clipDuration = 0;
  public videoDuration = 0;

  public audioTracks: AudioTrack[] = [];
  public selectedAudioTrackId: number | null = null;

  public clipState: ClipState = 'idle';
  public progress = 0;
  public errorMessage = '';
  public isSupported = true;
  public segmentCount = 0;

  private fragments: any[] = [];
  private ngUnsubscribe: Subject<void> = new Subject<void>();

  constructor(private clipService: ClipService) {}

  public ngOnInit(): void {
    this.isSupported = this.clipService.isSupported();

    this.viewerState.totalDuration$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((duration) => {
      this.videoDuration = duration;
      if (this.outPoint === 0 || this.outPoint > duration) {
        this.outPoint = duration;
      }
      this.updateClipDuration();
    });

    this.viewerState.fragments$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((frags) => {
      this.fragments = frags;
      this.updateSegmentCount();
    });

    this.viewerState.audioTracks$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((tracks) => {
      this.audioTracks = tracks;
      if (tracks.length > 0 && this.selectedAudioTrackId === null) {
        const defaultTrack = tracks.find((t) => t.default) || tracks[0];
        this.selectedAudioTrackId = defaultTrack.id;
      }
    });

    this.viewerState.selectedAudioTrack$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((track) => {
      if (track) {
        this.selectedAudioTrackId = track.id;
      }
    });

    this.clipService.state$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((state) => {
      this.clipState = state;
    });

    this.clipService.progress$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((progress) => {
      this.progress = progress;
    });

    this.clipService.error$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((error) => {
      this.errorMessage = error;
    });
  }

  public ngOnDestroy(): void {
    this.ngUnsubscribe.next();
  }

  public setInPointFromPlayhead(): void {
    if (this.viewerState.currentTime != null) {
      this.inPoint = Math.floor(this.viewerState.currentTime * 100) / 100;
      if (this.inPoint >= this.outPoint) {
        this.outPoint = Math.min(this.inPoint + 1, this.videoDuration);
      }
      this.updateClipDuration();
    }
  }

  public setOutPointFromPlayhead(): void {
    if (this.viewerState.currentTime != null) {
      this.outPoint = Math.floor(this.viewerState.currentTime * 100) / 100;
      if (this.outPoint <= this.inPoint) {
        this.inPoint = Math.max(this.outPoint - 1, 0);
      }
      this.updateClipDuration();
    }
  }

  public onInPointChange(): void {
    if (this.inPoint < 0) {
      this.inPoint = 0;
    }
    if (this.inPoint > this.videoDuration) {
      this.inPoint = this.videoDuration;
    }
    this.updateClipDuration();
  }

  public onOutPointChange(): void {
    if (this.outPoint < 0) {
      this.outPoint = 0;
    }
    if (this.outPoint > this.videoDuration) {
      this.outPoint = this.videoDuration;
    }
    this.updateClipDuration();
  }

  public onAudioTrackChange(): void {
    if (this.selectedAudioTrackId !== null) {
      this.viewerState.requestAudioTrackChange(this.selectedAudioTrackId);
    }
  }

  public startClip(): void {
    if (this.fragments.length === 0) {
      this.errorMessage = 'No segments available. Make sure a stream is loaded and playing.';
      return;
    }

    this.errorMessage = '';

    // Select audio track before clipping
    if (this.selectedAudioTrackId !== null) {
      this.viewerState.requestAudioTrackChange(this.selectedAudioTrackId);
    }

    this.clipService.startClip(this.fragments, { inPoint: this.inPoint, outPoint: this.outPoint }, this.viewerState.xhrCredentials);
  }

  public cancelClip(): void {
    this.clipService.cancelClip();
  }

  public resetClip(): void {
    this.inPoint = 0;
    this.outPoint = this.videoDuration;
    this.errorMessage = '';
    this.updateClipDuration();
  }

  public formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) {
      return '00:00.00';
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    if (h > 0) {
      return `${this.pad(h)}:${this.pad(m)}:${this.pad(s)}.${this.pad(ms)}`;
    }
    return `${this.pad(m)}:${this.pad(s)}.${this.pad(ms)}`;
  }

  private pad(n: number): string {
    return n < 10 ? '0' + n : '' + n;
  }

  private updateClipDuration(): void {
    this.clipDuration = Math.max(0, this.outPoint - this.inPoint);
    this.updateSegmentCount();
  }

  private updateSegmentCount(): void {
    if (this.fragments.length > 0) {
      this.segmentCount = this.clipService.getFragmentsInRange(this.fragments, {
        inPoint: this.inPoint,
        outPoint: this.outPoint,
      }).length;
    } else {
      this.segmentCount = 0;
    }
  }
}
