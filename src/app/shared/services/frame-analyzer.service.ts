import { Injectable } from '@angular/core';
import { Observable, Subject, BehaviorSubject } from 'rxjs';
import * as MP4Box from 'mp4box';
import * as muxjs from 'mux.js';

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
  containerType: 'mp4' | 'ts' | 'unknown';
}

export type ContainerType = 'mp4' | 'ts' | 'unknown';

@Injectable()
export class FrameAnalyzerService {
  private mp4boxfile: any;
  private frames: FrameInfo[] = [];
  private framesSubject = new Subject<FrameAnalysisResult>();
  private currentFrameData$ = new BehaviorSubject<FrameAnalysisResult | null>(null);
  private isAnalyzing$ = new BehaviorSubject<boolean>(false);
  private error$ = new Subject<string>();
  private containerType: ContainerType = 'unknown';

  constructor() {}

  get isAnalyzing(): Observable<boolean> {
    return this.isAnalyzing$.asObservable();
  }

  get errors(): Observable<string> {
    return this.error$.asObservable();
  }

  get currentFrameData(): Observable<FrameAnalysisResult | null> {
    return this.currentFrameData$.asObservable();
  }

  private detectContainerType(arrayBuffer: ArrayBuffer): ContainerType {
    const view = new DataView(arrayBuffer);

    // Check for MP4 ftyp box at start (offset 4)
    if (arrayBuffer.byteLength >= 8) {
      const boxType = view.getUint32(4);
      if (boxType === 0x66747970) {
        // 'ftyp'
        return 'mp4';
      }
    }

    // Check for MPEG-TS sync byte (0x47) every 188 or 192 bytes
    if (arrayBuffer.byteLength >= 376) {
      const firstByte = view.getUint8(0);
      const secondPacket188 = arrayBuffer.byteLength >= 188 ? view.getUint8(188) : 0;
      const secondPacket192 = arrayBuffer.byteLength >= 192 ? view.getUint8(192) : 0;

      if (firstByte === 0x47 && (secondPacket188 === 0x47 || secondPacket192 === 0x47)) {
        return 'ts';
      }
    }

    return 'unknown';
  }

  private transmuxTSToMP4(tsArrayBuffer: ArrayBuffer): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      try {
        const transmuxer = new muxjs.mp4.Transmuxer();
        let mp4Segments: Uint8Array[] = [];

        transmuxer.on('data', (segment: any) => {
          console.log('Transmuxer data event:', segment);

          // Combine init segment and data
          if (segment.initSegment) {
            mp4Segments.push(new Uint8Array(segment.initSegment.byteLength));
            mp4Segments[mp4Segments.length - 1].set(new Uint8Array(segment.initSegment));
          }
          if (segment.data) {
            mp4Segments.push(new Uint8Array(segment.data.byteLength));
            mp4Segments[mp4Segments.length - 1].set(new Uint8Array(segment.data));
          }
        });

        transmuxer.on('done', () => {
          console.log('Transmuxer done, segments:', mp4Segments.length);

          if (mp4Segments.length === 0) {
            reject(new Error('Transmuxer produced no output'));
            return;
          }

          // Calculate total length
          const totalLength = mp4Segments.reduce((sum, segment) => sum + segment.byteLength, 0);
          console.log('Total transmuxed size:', totalLength);

          // Combine all segments
          const combined = new Uint8Array(totalLength);
          let offset = 0;
          mp4Segments.forEach((segment) => {
            combined.set(segment, offset);
            offset += segment.byteLength;
          });

          resolve(combined.buffer);
        });

        // Push TS data to transmuxer
        const tsData = new Uint8Array(tsArrayBuffer);
        console.log('Pushing TS data to transmuxer, size:', tsData.byteLength);
        transmuxer.push(tsData);
        transmuxer.flush();
      } catch (error) {
        console.error('Transmux error:', error);
        reject(error);
      }
    });
  }

  public async analyzeSegment(arrayBuffer: ArrayBuffer): Promise<Observable<FrameAnalysisResult>> {
    this.frames = [];
    this.isAnalyzing$.next(true);

    // Detect container type
    this.containerType = this.detectContainerType(arrayBuffer);
    console.log('Detected container type:', this.containerType);

    try {
      let mp4ArrayBuffer: ArrayBuffer;

      // If TS, transmux to MP4 first
      if (this.containerType === 'ts') {
        console.log('Transmuxing TS to MP4...');
        mp4ArrayBuffer = await this.transmuxTSToMP4(arrayBuffer);
        console.log('Transmuxing complete, MP4 size:', mp4ArrayBuffer.byteLength);
      } else if (this.containerType === 'mp4') {
        mp4ArrayBuffer = arrayBuffer;
      } else {
        this.error$.next('Unknown container type. Supported formats: MP4, fMP4, MPEG-TS');
        this.isAnalyzing$.next(false);
        return this.framesSubject.asObservable();
      }

      // Now analyze the MP4 with mp4box
      this.analyzeMp4(mp4ArrayBuffer);
    } catch (error) {
      console.error('Analysis error:', error);
      this.error$.next(`Error processing segment: ${error.message || 'Unknown error'}`);
      this.isAnalyzing$.next(false);
    }

    return this.framesSubject.asObservable();
  }

  private analyzeMp4(arrayBuffer: ArrayBuffer): void {
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
        containerType: this.containerType,
      };

      console.log('Frame analysis result:', result);
      this.framesSubject.next(result);
      this.currentFrameData$.next(result);
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
