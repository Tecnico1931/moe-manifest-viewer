// Typings reference file, see links for more information
// https://github.com/typings/typings
// https://www.typescriptlang.org/docs/handbook/writing-declaration-files.html

declare var System: any;
declare var HlsTs: any;

// MediaRecorder API types (not included in TypeScript 3.8 DOM lib)
interface MediaRecorderOptions {
  mimeType?: string;
  audioBitsPerSecond?: number;
  videoBitsPerSecond?: number;
  bitsPerSecond?: number;
}

interface BlobEvent extends Event {
  data: Blob;
  timecode?: number;
}

declare class MediaRecorder extends EventTarget {
  constructor(stream: MediaStream, options?: MediaRecorderOptions);
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: ((event: Event) => void) | null;
  onstart: ((event: Event) => void) | null;
  onpause: ((event: Event) => void) | null;
  onresume: ((event: Event) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  static isTypeSupported(mimeType: string): boolean;
}

// Custom type definitions to override broken mp4box types
declare module 'mp4box' {
  export interface MP4Sample {
    is_sync: boolean;
    timescale: number;
    dts: number;
    cts: number;
    duration: number;
    size: number;
    data?: ArrayBuffer;
  }

  export interface MP4Track {
    id: number;
    name: string;
    type: string;
    timescale: number;
    duration: number;
    nb_samples: number;
    codec: string;
    language?: string;
    video?: {
      width: number;
      height: number;
    };
    audio?: {
      sample_rate: number;
      channel_count: number;
    };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
    created: Date;
    modified: Date;
    tracks: MP4Track[];
  }

  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }

  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: any, samples: MP4Sample[]) => void;

    appendBuffer(data: MP4ArrayBuffer): number;
    start(): void;
    stop(): void;
    flush(): void;
    setExtractionOptions(id: number, user?: any, options?: any): void;
  }

  export function createFile(): MP4File;
}
