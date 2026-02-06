import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import * as download from 'downloadjs';

export type ClipState = 'idle' | 'downloading' | 'processing' | 'done' | 'error';

export interface ClipRange {
  inPoint: number;
  outPoint: number;
}

export interface ClipFragment {
  url: string;
  start: number;
  duration: number;
}

@Injectable()
export class ClipService {
  public state$ = new BehaviorSubject<ClipState>('idle');
  public progress$ = new BehaviorSubject<number>(0);
  public error$ = new Subject<string>();

  private cancelled = false;

  constructor(private zone: NgZone) {}

  /**
   * Determine file extension from segment URLs.
   * TS segments -> .ts, fMP4 segments -> .mp4
   */
  public getFileExtension(fragments: ClipFragment[]): string {
    if (fragments.length === 0) {
      return 'ts';
    }
    const url = fragments[0].url.split('?')[0].toLowerCase();
    if (url.endsWith('.mp4') || url.endsWith('.m4s') || url.endsWith('.m4v')) {
      return 'mp4';
    }
    return 'ts';
  }

  /**
   * Check if segment-based clipping is available (requires fragments).
   */
  public isSupported(): boolean {
    return true;
  }

  /**
   * Find fragments that overlap with the given clip range.
   */
  public getFragmentsInRange(allFragments: any[], clipRange: ClipRange): ClipFragment[] {
    const result: ClipFragment[] = [];
    for (const frag of allFragments) {
      if (frag.start === undefined || frag.duration === undefined) {
        continue;
      }
      const fragEnd = frag.start + frag.duration;
      if (fragEnd > clipRange.inPoint && frag.start < clipRange.outPoint) {
        const url = frag.url || (frag.baseurl ? frag.baseurl + frag.relurl : frag.relurl);
        if (url) {
          result.push({
            url,
            start: frag.start,
            duration: frag.duration,
          });
        }
      }
    }
    return result;
  }

  /**
   * Start clipping by downloading and concatenating segments.
   * This is faster than real-time — no playback needed.
   */
  public async startClip(fragments: any[], clipRange: ClipRange, xhrCredentials: boolean): Promise<void> {
    if (clipRange.inPoint >= clipRange.outPoint) {
      this.error$.next('In-point must be before out-point.');
      this.state$.next('error');
      return;
    }

    const matchingFragments = this.getFragmentsInRange(fragments, clipRange);

    if (matchingFragments.length === 0) {
      this.error$.next('No segments found in the selected range. Make sure the stream has loaded.');
      this.state$.next('error');
      return;
    }

    this.cancelled = false;
    this.progress$.next(0);
    this.state$.next('downloading');

    try {
      const buffers: ArrayBuffer[] = [];
      for (let i = 0; i < matchingFragments.length; i++) {
        if (this.cancelled) {
          this.state$.next('idle');
          this.progress$.next(0);
          return;
        }

        const frag = matchingFragments[i];
        const fetchOptions: RequestInit = {
          cache: 'no-store',
        };
        if (xhrCredentials) {
          fetchOptions.credentials = 'include';
        }
        const response = await fetch(frag.url, fetchOptions);
        if (!response.ok) {
          throw new Error(`Failed to fetch segment ${i + 1}: ${response.status} ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        buffers.push(buffer);

        const pct = Math.round(((i + 1) / matchingFragments.length) * 100);
        this.zone.run(() => this.progress$.next(pct));
      }

      if (this.cancelled) {
        this.state$.next('idle');
        this.progress$.next(0);
        return;
      }

      this.zone.run(() => this.state$.next('processing'));

      const totalSize = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const buf of buffers) {
        combined.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }

      const ext = this.getFileExtension(matchingFragments);
      const mimeType = ext === 'ts' ? 'video/mp2t' : 'video/mp4';
      const blob = new Blob([combined], { type: mimeType });
      const inPt = this.formatTime(clipRange.inPoint);
      const outPt = this.formatTime(clipRange.outPoint);
      const filename = `clip_${inPt}-${outPt}.${ext}`;

      download(blob, filename, mimeType);

      this.zone.run(() => {
        this.state$.next('done');
        this.progress$.next(100);
      });
    } catch (e) {
      if (!this.cancelled) {
        this.zone.run(() => {
          this.error$.next('Clip failed: ' + (e as Error).message);
          this.state$.next('error');
        });
      }
    }
  }

  /**
   * Cancel an in-progress download.
   */
  public cancelClip(): void {
    this.cancelled = true;
    this.state$.next('idle');
    this.progress$.next(0);
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m${s}s`;
  }
}
