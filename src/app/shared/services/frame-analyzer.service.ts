import { Injectable } from '@angular/core';
import { Observable, Subject, BehaviorSubject } from 'rxjs';
import * as MP4Box from 'mp4box';

export interface FrameInfo {
  pts: number;
  dts: number;
  duration: number;
  isKeyframe: boolean;
  size: number;
  type: 'I-frame' | 'P/B-frame';
}

export interface FrameAnalysisResult {
  frames: FrameInfo[];
  totalFrames: number;
  keyframeCount: number;
  gopSize: number;
  duration: number;
}

@Injectable()
export class FrameAnalyzerService {
  private mp4boxfile: any;
  private frames: FrameInfo[] = [];
  private framesSubject = new Subject<FrameAnalysisResult>();
  private isAnalyzing$ = new BehaviorSubject<boolean>(false);
  private error$ = new Subject<string>();

  constructor() {}

  get isAnalyzing(): Observable<boolean> {
    return this.isAnalyzing$.asObservable();
  }

  get errors(): Observable<string> {
    return this.error$.asObservable();
  }

  public analyzeSegment(arrayBuffer: ArrayBuffer): Observable<FrameAnalysisResult> {
    this.frames = [];
    this.isAnalyzing$.next(true);
    this.mp4boxfile = MP4Box.createFile();

    this.mp4boxfile.onError = (e: any) => {
      console.error('MP4Box error:', e);
      this.error$.next(`Failed to parse segment: ${e.message || 'Unknown error'}`);
      this.isAnalyzing$.next(false);
    };

    this.mp4boxfile.onReady = (info: any) => {
      console.log('MP4Box ready, info:', info);
      const videoTrack = info.videoTracks && info.videoTracks.length > 0 ? info.videoTracks[0] : null;

      if (!videoTrack) {
        this.error$.next('No video track found in segment');
        this.isAnalyzing$.next(false);
        return;
      }

      console.log('Video track found:', videoTrack);
      this.mp4boxfile.setExtractionOptions(videoTrack.id, null, {
        nbSamples: 100000,
      });
      this.mp4boxfile.start();
    };

    this.mp4boxfile.onSamples = (id: number, user: any, samples: any[]) => {
      console.log(`Received ${samples.length} samples from track ${id}`);

      samples.forEach((sample) => {
        this.frames.push({
          pts: sample.cts,
          dts: sample.dts,
          duration: sample.duration,
          isKeyframe: sample.is_sync,
          size: sample.size,
          type: sample.is_sync ? 'I-frame' : 'P/B-frame',
        });
      });

      const result: FrameAnalysisResult = {
        frames: [...this.frames],
        totalFrames: this.frames.length,
        keyframeCount: this.frames.filter((f) => f.isKeyframe).length,
        gopSize: this.frames.length > 0 ? this.frames.length / Math.max(1, this.frames.filter((f) => f.isKeyframe).length) : 0,
        duration: this.frames.length > 0 ? this.frames[this.frames.length - 1].pts + this.frames[this.frames.length - 1].duration : 0,
      };

      console.log('Frame analysis result:', result);
      this.framesSubject.next(result);
      this.isAnalyzing$.next(false);
    };

    try {
      (arrayBuffer as any).fileStart = 0;
      this.mp4boxfile.appendBuffer(arrayBuffer);
      this.mp4boxfile.flush();
    } catch (e) {
      console.error('Error appending buffer:', e);
      this.error$.next(`Error processing segment: ${e.message || 'Unknown error'}`);
      this.isAnalyzing$.next(false);
    }

    return this.framesSubject.asObservable();
  }

  public getKeyframePositions(): number[] {
    return this.frames.filter((f) => f.isKeyframe).map((f) => f.pts);
  }

  public getFrameCount(): { total: number; keyframes: number; gopSize: number } {
    const keyframeCount = this.frames.filter((f) => f.isKeyframe).length;
    return {
      total: this.frames.length,
      keyframes: keyframeCount,
      gopSize: this.frames.length > 0 ? this.frames.length / Math.max(1, keyframeCount) : 0,
    };
  }

  public getFrameAtTime(timeMs: number): FrameInfo | null {
    for (const frame of this.frames) {
      if (frame.pts <= timeMs && frame.pts + frame.duration > timeMs) {
        return frame;
      }
    }
    return null;
  }

  public reset(): void {
    this.frames = [];
    this.mp4boxfile = null;
  }
}
