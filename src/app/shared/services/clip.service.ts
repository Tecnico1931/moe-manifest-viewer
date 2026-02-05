import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import * as download from 'downloadjs';

export type ClipState = 'idle' | 'recording' | 'processing' | 'done' | 'error';

export interface ClipRange {
  inPoint: number;
  outPoint: number;
}

@Injectable()
export class ClipService {
  public state$ = new BehaviorSubject<ClipState>('idle');
  public progress$ = new BehaviorSubject<number>(0);
  public error$ = new Subject<string>();

  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private videoElement: HTMLVideoElement | null = null;
  private clipRange: ClipRange | null = null;
  private timeUpdateHandler: (() => void) | null = null;
  private previousPlaybackRate: number;
  private previousMuted: boolean;

  constructor(private zone: NgZone) {}

  /**
   * Get supported MIME type for recording.
   * Prefer MP4 if available, fall back to WebM.
   */
  public getSupportedMimeType(): string {
    const mimeTypes = [
      'video/mp4;codecs=h264,aac',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const mime of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return '';
  }

  /**
   * Get file extension for the supported MIME type.
   */
  public getFileExtension(): string {
    const mime = this.getSupportedMimeType();
    return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  /**
   * Check if MediaRecorder is available in this browser.
   */
  public isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && this.getSupportedMimeType() !== '';
  }

  /**
   * Start recording a clip from the given video element.
   * Seeks to inPoint and records until outPoint.
   */
  public startClip(videoElement: HTMLVideoElement, clipRange: ClipRange): void {
    if (!this.isSupported()) {
      this.error$.next('MediaRecorder is not supported in this browser.');
      this.state$.next('error');
      return;
    }

    if (clipRange.inPoint >= clipRange.outPoint) {
      this.error$.next('In-point must be before out-point.');
      this.state$.next('error');
      return;
    }

    this.videoElement = videoElement;
    this.clipRange = clipRange;
    this.chunks = [];
    this.progress$.next(0);
    this.previousPlaybackRate = videoElement.playbackRate;
    this.previousMuted = videoElement.muted;

    // Seek to in-point
    videoElement.currentTime = clipRange.inPoint;
    videoElement.muted = false;

    const onSeeked = () => {
      videoElement.removeEventListener('seeked', onSeeked);
      this.beginRecording();
    };
    videoElement.addEventListener('seeked', onSeeked);
  }

  /**
   * Cancel an in-progress recording.
   */
  public cancelClip(): void {
    this.stopRecording(true);
  }

  private beginRecording(): void {
    if (!this.videoElement || !this.clipRange) {
      return;
    }

    const stream = (this.videoElement as any).captureStream();
    const mimeType = this.getSupportedMimeType();

    try {
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 8000000,
      });
    } catch (e) {
      this.error$.next('Failed to create MediaRecorder: ' + (e as Error).message);
      this.state$.next('error');
      return;
    }

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      this.zone.run(() => this.onRecordingComplete());
    };

    this.mediaRecorder.onerror = (event: any) => {
      this.zone.run(() => {
        this.error$.next('Recording error: ' + (event.error?.message || 'Unknown error'));
        this.state$.next('error');
        this.cleanup();
      });
    };

    // Monitor time to stop at out-point
    this.timeUpdateHandler = () => {
      if (!this.videoElement || !this.clipRange) {
        return;
      }
      const current = this.videoElement.currentTime;
      const duration = this.clipRange.outPoint - this.clipRange.inPoint;
      const elapsed = current - this.clipRange.inPoint;
      const pct = Math.min(100, Math.max(0, (elapsed / duration) * 100));
      this.zone.run(() => this.progress$.next(pct));

      if (current >= this.clipRange.outPoint) {
        this.stopRecording(false);
      }
    };

    this.videoElement.addEventListener('timeupdate', this.timeUpdateHandler);
    this.mediaRecorder.start(100);
    this.videoElement.play();
    this.state$.next('recording');
  }

  private stopRecording(cancelled: boolean): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.muted = this.previousMuted;
      this.videoElement.playbackRate = this.previousPlaybackRate;
    }

    if (this.timeUpdateHandler && this.videoElement) {
      this.videoElement.removeEventListener('timeupdate', this.timeUpdateHandler);
      this.timeUpdateHandler = null;
    }

    if (cancelled) {
      this.chunks = [];
      this.state$.next('idle');
      this.progress$.next(0);
      this.mediaRecorder = null;
    }
  }

  private onRecordingComplete(): void {
    if (this.chunks.length === 0) {
      this.state$.next('idle');
      return;
    }

    this.state$.next('processing');
    const mimeType = this.getSupportedMimeType();
    const blob = new Blob(this.chunks, { type: mimeType });
    const ext = this.getFileExtension();
    const inPt = this.clipRange ? this.formatTime(this.clipRange.inPoint) : '0';
    const outPt = this.clipRange ? this.formatTime(this.clipRange.outPoint) : '0';
    const filename = `clip_${inPt}-${outPt}.${ext}`;

    download(blob, filename, mimeType);

    this.state$.next('done');
    this.progress$.next(100);
    this.cleanup();
  }

  private cleanup(): void {
    this.mediaRecorder = null;
    this.chunks = [];
    this.clipRange = null;
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m${s}s`;
  }
}
