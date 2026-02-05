import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export type WhisperTask = 'transcribe' | 'translate';

export interface WhisperModelInfo {
  id: string;
  label: string;
  size: string;
}

export interface WhisperCaption {
  start: number;
  end: number;
  text: string;
}

export type WhisperState = 'idle' | 'loading-library' | 'loading-model' | 'transcribing' | 'done' | 'error';

@Injectable()
export class WhisperService {
  public state$ = new BehaviorSubject<WhisperState>('idle');
  public modelProgress$ = new BehaviorSubject<number>(0);
  public transcriptionProgress$ = new BehaviorSubject<number>(0);
  public captions$ = new BehaviorSubject<WhisperCaption[]>([]);
  public error$ = new Subject<string>();
  public currentCaption$ = new BehaviorSubject<string>('');

  public static MODELS: WhisperModelInfo[] = [
    { id: 'Xenova/whisper-tiny', label: 'Tiny (Multilingual)', size: '~75 MB' },
    { id: 'Xenova/whisper-tiny.en', label: 'Tiny (EN only)', size: '~75 MB' },
    { id: 'Xenova/whisper-base', label: 'Base (Multilingual)', size: '~150 MB' },
    { id: 'Xenova/whisper-base.en', label: 'Base (EN only)', size: '~150 MB' },
    { id: 'Xenova/whisper-small', label: 'Small (Multilingual)', size: '~500 MB' },
  ];

  private pipelineFn: any = null;
  private transcriber: any = null;
  private cancelled = false;
  private micStream: MediaStream | null = null;
  private micAudioContext: any = null;
  private micProcessor: any = null;
  private micSource: any = null;

  constructor(private zone: NgZone) {}

  /**
   * Dynamically load @xenova/transformers from CDN.
   */
  public async loadLibrary(): Promise<void> {
    if (this.pipelineFn) {
      return;
    }

    this.state$.next('loading-library');

    try {
      await new Promise<void>((resolve, reject) => {
        const eventName = '__whisper_ready_' + Date.now();

        const handler = () => {
          this.pipelineFn = (window as any).__whisperPipeline;
          if (this.pipelineFn) {
            resolve();
          } else {
            reject(new Error('Failed to initialize transformers.js pipeline'));
          }
        };

        window.addEventListener(eventName, handler, { once: true });

        const script = document.createElement('script');
        script.type = 'module';
        script.textContent =
          'import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";' +
          'env.allowLocalModels = false;' +
          'window.__whisperPipeline = pipeline;' +
          'window.dispatchEvent(new CustomEvent("' +
          eventName +
          '"));';
        document.head.appendChild(script);

        setTimeout(() => {
          reject(new Error('Timeout loading AI library from CDN. Check your internet connection.'));
        }, 60000);
      });
    } catch (e) {
      this.zone.run(() => {
        this.state$.next('error');
        this.error$.next('Failed to load AI library: ' + (e as Error).message);
      });
      throw e;
    }
  }

  /**
   * Load a Whisper model with progress tracking.
   */
  public async loadModel(modelId: string): Promise<void> {
    if (!this.pipelineFn) {
      await this.loadLibrary();
    }

    this.zone.run(() => {
      this.state$.next('loading-model');
      this.modelProgress$.next(0);
    });

    try {
      this.transcriber = await this.pipelineFn('automatic-speech-recognition', modelId, {
        progress_callback: (progress: any) => {
          if (progress.status === 'progress' && progress.progress != null) {
            this.zone.run(() => this.modelProgress$.next(Math.round(progress.progress)));
          }
        },
      });

      this.zone.run(() => {
        this.modelProgress$.next(100);
        this.state$.next('idle');
      });
    } catch (e) {
      this.zone.run(() => {
        this.state$.next('error');
        this.error$.next('Failed to load model: ' + (e as Error).message);
      });
      throw e;
    }
  }

  public isModelLoaded(): boolean {
    return this.transcriber !== null;
  }

  /**
   * Transcribe audio from stream segments (faster than real-time).
   */
  public async transcribeSegments(
    fragments: any[],
    inPoint: number,
    outPoint: number,
    xhrCredentials: boolean,
    task: WhisperTask = 'transcribe'
  ): Promise<WhisperCaption[]> {
    if (!this.transcriber) {
      this.error$.next('Model not loaded. Please load a model first.');
      return [];
    }

    this.cancelled = false;
    this.captions$.next([]);
    this.transcriptionProgress$.next(0);
    this.state$.next('transcribing');

    try {
      const matchingFragments = this.getFragmentsInRange(fragments, inPoint, outPoint);

      if (matchingFragments.length === 0) {
        throw new Error('No segments found in the selected range.');
      }

      // Download and decode audio from each segment
      const allAudio: Float32Array[] = [];

      for (let i = 0; i < matchingFragments.length; i++) {
        if (this.cancelled) {
          this.zone.run(() => {
            this.state$.next('idle');
            this.transcriptionProgress$.next(0);
          });
          return [];
        }

        const frag = matchingFragments[i];
        const fetchOptions: RequestInit = { cache: 'no-store' };
        if (xhrCredentials) {
          fetchOptions.credentials = 'include';
        }

        const response = await fetch(frag.url, fetchOptions);
        if (!response.ok) {
          throw new Error('Failed to fetch segment ' + (i + 1) + ': ' + response.status);
        }

        const buffer = await response.arrayBuffer();

        try {
          const audioData = await this.decodeAudioToFloat32(buffer);
          allAudio.push(audioData);
        } catch (decodeErr) {
          console.warn('Could not decode audio from segment ' + (i + 1) + ', skipping.', decodeErr);
        }

        const pct = Math.round(((i + 1) / matchingFragments.length) * 50);
        this.zone.run(() => this.transcriptionProgress$.next(pct));
      }

      if (allAudio.length === 0) {
        throw new Error('Could not decode audio from any segments. The format may not be supported by the browser.');
      }

      if (this.cancelled) {
        this.zone.run(() => {
          this.state$.next('idle');
          this.transcriptionProgress$.next(0);
        });
        return [];
      }

      // Concatenate all audio
      const totalLength = allAudio.reduce((sum, a) => sum + a.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of allAudio) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      this.zone.run(() => this.transcriptionProgress$.next(60));

      const timeOffset = matchingFragments[0].start;

      // Run Whisper
      const result = await this.transcriber(combined, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
        task: task,
      });

      if (this.cancelled) {
        this.zone.run(() => {
          this.state$.next('idle');
          this.transcriptionProgress$.next(0);
        });
        return [];
      }

      // Build captions from result
      const captions: WhisperCaption[] = [];
      if (result && result.chunks) {
        for (const chunk of result.chunks) {
          const start = (chunk.timestamp[0] || 0) + timeOffset;
          const end = (chunk.timestamp[1] || chunk.timestamp[0] + 2) + timeOffset;
          const text = chunk.text ? chunk.text.trim() : '';
          if (text) {
            captions.push({ start, end, text });
          }
        }
      } else if (result && result.text) {
        captions.push({
          start: timeOffset,
          end: timeOffset + combined.length / 16000,
          text: result.text.trim(),
        });
      }

      this.zone.run(() => {
        this.captions$.next(captions);
        this.transcriptionProgress$.next(100);
        this.state$.next('done');
      });

      return captions;
    } catch (e) {
      if (!this.cancelled) {
        this.zone.run(() => {
          this.error$.next((e as Error).message);
          this.state$.next('error');
        });
      }
      return [];
    }
  }

  /**
   * Start real-time transcription from the microphone.
   */
  public async startMicrophoneTranscription(task: WhisperTask = 'transcribe'): Promise<void> {
    if (!this.transcriber) {
      this.error$.next('Model not loaded. Please load a model first.');
      return;
    }

    this.cancelled = false;
    this.state$.next('transcribing');

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.micAudioContext = new AudioCtx({ sampleRate: 16000 });
      this.micSource = this.micAudioContext.createMediaStreamSource(this.micStream);
      this.micProcessor = this.micAudioContext.createScriptProcessor(4096, 1, 1);

      let audioChunks: Float32Array[] = [];
      let chunkStartTime = Date.now();
      let processing = false;
      const CHUNK_MS = 5000;

      this.micProcessor.onaudioprocess = (e: any) => {
        if (this.cancelled || processing) {
          return;
        }

        const channelData = e.inputBuffer.getChannelData(0);
        audioChunks.push(new Float32Array(channelData));

        if (Date.now() - chunkStartTime >= CHUNK_MS && audioChunks.length > 0) {
          const chunks = audioChunks;
          audioChunks = [];
          chunkStartTime = Date.now();
          processing = true;

          const totalLen = chunks.reduce((s, c) => s + c.length, 0);
          const audio = new Float32Array(totalLen);
          let off = 0;
          for (const c of chunks) {
            audio.set(c, off);
            off += c.length;
          }

          this.transcriber(audio, {
            chunk_length_s: 10,
            return_timestamps: false,
            task: task,
          })
            .then((result: any) => {
              processing = false;
              if (result && result.text && result.text.trim()) {
                const currentCaptions = this.captions$.value;
                const newCaption: WhisperCaption = {
                  start: 0,
                  end: 0,
                  text: result.text.trim(),
                };
                this.zone.run(() => {
                  this.captions$.next([...currentCaptions, newCaption]);
                  this.currentCaption$.next(result.text.trim());
                });
              }
            })
            .catch(() => {
              processing = false;
            });
        }
      };

      this.micSource.connect(this.micProcessor);
      this.micProcessor.connect(this.micAudioContext.destination);
    } catch (e) {
      this.zone.run(() => {
        this.error$.next('Microphone access failed: ' + (e as Error).message);
        this.state$.next('error');
      });
    }
  }

  /**
   * Stop microphone transcription.
   */
  public stopMicrophoneTranscription(): void {
    this.cancelled = true;
    if (this.micProcessor) {
      this.micProcessor.disconnect();
      this.micProcessor = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.micAudioContext) {
      this.micAudioContext.close();
      this.micAudioContext = null;
    }
    this.state$.next('idle');
  }

  /**
   * Cancel any in-progress transcription.
   */
  public cancel(): void {
    this.cancelled = true;
    this.stopMicrophoneTranscription();
    this.state$.next('idle');
    this.transcriptionProgress$.next(0);
  }

  /**
   * Update the current caption for video overlay based on playback time.
   */
  public updateCaptionForTime(currentTime: number): void {
    const captions = this.captions$.value;
    const active = captions.find((c) => currentTime >= c.start && currentTime <= c.end);
    const text = active ? active.text : '';
    if (text !== this.currentCaption$.value) {
      this.currentCaption$.next(text);
    }
  }

  /**
   * Export captions as WebVTT.
   */
  public exportAsVTT(): string {
    const captions = this.captions$.value;
    let vtt = 'WEBVTT\n\n';
    captions.forEach((cap, i) => {
      vtt += i + 1 + '\n';
      vtt += this.formatVTTTime(cap.start) + ' --> ' + this.formatVTTTime(cap.end) + '\n';
      vtt += cap.text + '\n\n';
    });
    return vtt;
  }

  /**
   * Export captions as SRT.
   */
  public exportAsSRT(): string {
    const captions = this.captions$.value;
    let srt = '';
    captions.forEach((cap, i) => {
      srt += i + 1 + '\n';
      srt += this.formatSRTTime(cap.start) + ' --> ' + this.formatSRTTime(cap.end) + '\n';
      srt += cap.text + '\n\n';
    });
    return srt;
  }

  /**
   * Clear all captions.
   */
  public clearCaptions(): void {
    this.captions$.next([]);
    this.currentCaption$.next('');
  }

  private getFragmentsInRange(allFragments: any[], inPoint: number, outPoint: number): any[] {
    const result: any[] = [];
    for (const frag of allFragments) {
      if (frag.start === undefined || frag.duration === undefined) {
        continue;
      }
      const fragEnd = frag.start + frag.duration;
      if (fragEnd > inPoint && frag.start < outPoint) {
        const url = frag.url || (frag.baseurl ? frag.baseurl + frag.relurl : frag.relurl);
        if (url) {
          result.push({ url, start: frag.start, duration: frag.duration });
        }
      }
    }
    return result;
  }

  private async decodeAudioToFloat32(buffer: ArrayBuffer): Promise<Float32Array> {
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx({ sampleRate: 16000 });

    try {
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
      const channelData = audioBuffer.getChannelData(0);

      if (audioBuffer.sampleRate !== 16000) {
        return this.resample(channelData, audioBuffer.sampleRate, 16000);
      }

      return new Float32Array(channelData);
    } finally {
      ctx.close();
    }
  }

  private resample(data: Float32Array, fromRate: number, toRate: number): Float32Array {
    const ratio = fromRate / toRate;
    const newLength = Math.round(data.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const srcFloor = Math.floor(srcIndex);
      const srcCeil = Math.min(srcFloor + 1, data.length - 1);
      const frac = srcIndex - srcFloor;
      result[i] = data[srcFloor] * (1 - frac) + data[srcCeil] * frac;
    }
    return result;
  }

  private formatVTTTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return this.pad2(h) + ':' + this.pad2(m) + ':' + this.pad2(s) + '.' + this.pad3(ms);
  }

  private formatSRTTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return this.pad2(h) + ':' + this.pad2(m) + ':' + this.pad2(s) + ',' + this.pad3(ms);
  }

  private pad2(n: number): string {
    return n < 10 ? '0' + n : '' + n;
  }

  private pad3(n: number): string {
    if (n < 10) {
      return '00' + n;
    }
    if (n < 100) {
      return '0' + n;
    }
    return '' + n;
  }
}
