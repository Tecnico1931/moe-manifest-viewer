import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { PlaylistSummary } from '../../components/live-mode/live-mode.logic';

export type RequestKind =
  | 'master'
  | 'variant'
  | 'audio-playlist'
  | 'subtitle-playlist'
  | 'init'
  | 'video-segment'
  | 'audio-segment'
  | 'subtitle-segment'
  | 'key'
  | 'other';

/** One network request made by a player. All times are performance.now() ms. */
export interface RequestRecord {
  id: number;
  url: string;
  kind: RequestKind;
  level?: number;
  bandwidthDeclared?: number;
  averageBandwidthDeclared?: number;
  resolution?: string;
  codecs?: string;
  audioGroup?: string;
  trackName?: string;
  sn?: number;
  durationSec?: number;
  bytes?: number;
  status?: number;
  tRequest: number;
  tFirstByte?: number;
  tLoaded?: number;
  /** Lower-cased response headers. Only CORS-exposed headers are readable from a browser (see parseResponseHeaders). */
  headers?: Record<string, string>;
  fromCache?: boolean;
  error?: string;
  /** Bytes on the wire (PerformanceResourceTiming.transferSize), when the browser exposes it. */
  transferSize?: number;
  /** Digest of a media playlist response (no URLs), used by the Live panel. */
  playlist?: PlaylistSummary;
}

/** Declared ladder data for a rendition, as listed in the master playlist. */
export interface DeclaredLevel {
  bandwidth?: number;
  averageBandwidth?: number;
  resolution?: string;
  codecs?: string;
  audioGroup?: string;
}

export interface DeclaredAudioTrack {
  name?: string;
  groupId?: string;
}

/** `audioTrackId` is looked up in setAudioTracks to fill trackName/audioGroup; it is not stored. */
export type BeginInit = Partial<RequestRecord> & { url: string; kind: RequestKind; audioTrackId?: number };

const MAX_RECORDS = 3000;
const PERF_MATCH_WINDOW_MS = 50;

/**
 * Per-viewer log of every request the player makes (HLS.js via the custom loader, Shaka via networking filters,
 * dash.js via fragment events). Provided on ManifestViewerComponent, so each viewer has its own instance; inject it
 * from any descendant component (info-container panels, players).
 */
@Injectable()
export class RequestLogService implements OnDestroy {
  public readonly records$ = new BehaviorSubject<RequestRecord[]>([]);
  /** performance.now() of the first master request in this session, undefined until one is seen. */
  public sessionStart?: number;

  private nextId = 1;
  private levels: DeclaredLevel[] = [];
  private audioTracks: DeclaredAudioTrack[] = [];
  private perfMatched = new Set<number>();
  private audioTrackIds = new Map<number, number>(); // record id -> audio track id, for back-filling
  private perfObserver?: PerformanceObserver;

  constructor() {
    this.startResourceObserver();
  }

  public ngOnDestroy(): void {
    this.perfObserver?.disconnect();
  }

  public get records(): RequestRecord[] {
    return this.records$.value;
  }

  /** Called when a new manifest is loaded. */
  public reset(): void {
    this.sessionStart = undefined;
    this.nextId = 1;
    this.levels = [];
    this.audioTracks = [];
    this.perfMatched.clear();
    this.audioTrackIds.clear();
    this.records$.next([]);
  }

  public byKind(kind: RequestKind): RequestRecord[] {
    return this.records.filter((record) => record.kind === kind);
  }

  public firstOf(kind: RequestKind): RequestRecord | undefined {
    const earliest = (first: RequestRecord | undefined, r: RequestRecord) => (!first || r.tRequest < first.tRequest ? r : first);
    return this.byKind(kind).reduce<RequestRecord | undefined>(earliest, undefined);
  }

  /** Starts a record and returns its id. Declared ladder data is filled in from setLevels/setAudioTracks. */
  public begin(init: BeginInit): number {
    const id = this.nextId++;
    const tRequest = init.tRequest ?? performance.now();
    const { audioTrackId, ...fields } = init;
    const record: RequestRecord = { ...this.withDeclared(fields, audioTrackId), id, tRequest };
    if (audioTrackId !== undefined) {
      this.audioTrackIds.set(id, audioTrackId);
    }
    if (record.kind === 'master' && this.sessionStart === undefined) {
      this.sessionStart = tRequest;
    }
    const all = [...this.records, record];
    this.records$.next(all.length > MAX_RECORDS ? this.trim(all) : all);
    return id;
  }

  public update(id: number, patch: Partial<RequestRecord>): void {
    this.records$.next(this.records.map((record) => (record.id === id ? { ...record, ...patch, id } : record)));
  }

  /** Declared renditions from the master playlist, indexed like the player's level list (copy). */
  public get declaredLevels(): DeclaredLevel[] {
    return this.levels.slice();
  }

  /** Declared renditions, indexed like the player's level list. Back-fills records already logged. */
  public setLevels(levels: DeclaredLevel[]): void {
    this.levels = levels;
    this.records$.next(this.records.map((record) => this.withDeclared(record)));
  }


  public setAudioTracks(tracks: DeclaredAudioTrack[]): void {
    this.audioTracks = tracks;
    this.records$.next(this.records.map((record) => this.withDeclared(record, this.audioTrackIds.get(record.id))));
  }

  /** Shaka: records requests through the networking engine's request/response filters. Best effort. */
  public attachShaka(engine: any): void {
    const ids = new WeakMap<object, number>();
    engine?.registerRequestFilter((type: number, request: any, context?: any) => {
      ids.set(request, this.begin({ url: request.uris?.[0] ?? '', kind: this.shakaKind(type, context) }));
    });
    engine?.registerResponseFilter((type: number, response: any) => {
      const id = response.originalRequest ? ids.get(response.originalRequest) : undefined;
      if (id === undefined) {
        return;
      }
      const tRequest = this.records.find((record) => record.id === id)?.tRequest ?? performance.now();
      this.update(id, {
        bytes: response.data?.byteLength,
        headers: response.headers,
        fromCache: response.fromCache,
        tLoaded: tRequest + (response.timeMs ?? 0),
      });
    });
  }

  /** dash.js: call with the `request` from FRAGMENT_LOADING_COMPLETED. Dates are wall clock, converted to performance.now(). */
  public recordDashRequest(request: any): void {
    if (!request?.url) {
      return;
    }
    const toPerf = (date?: Date): number | undefined => (date ? performance.now() - (Date.now() - date.getTime()) : undefined);
    const media = request.mediaType;
    this.begin({
      url: request.url,
      kind: request.type === 'InitializationSegment' ? 'init' : media === 'audio' ? 'audio-segment' : media === 'video' ? 'video-segment' : 'other',
      sn: request.index,
      durationSec: request.duration,
      bytes: request.bytesLoaded,
      status: request.responseCode,
      tRequest: toPerf(request.requestStartDate),
      tFirstByte: toPerf(request.firstByteDate),
      tLoaded: toPerf(request.requestEndDate),
    });
  }

  private withDeclared<T extends Partial<RequestRecord>>(record: T, audioTrackId?: number): T {
    const hasLevel = record.level !== undefined && (record.kind === 'variant' || record.kind === 'video-segment' || record.kind === 'init');
    const declared = hasLevel ? this.levels[record.level as number] : undefined;
    const track = audioTrackId !== undefined ? this.audioTracks[audioTrackId] : undefined;
    return {
      ...record,
      ...(declared && {
        bandwidthDeclared: declared.bandwidth,
        averageBandwidthDeclared: declared.averageBandwidth,
        resolution: declared.resolution,
        codecs: declared.codecs,
        audioGroup: declared.audioGroup,
      }),
      ...(track && { trackName: track.name, audioGroup: track.groupId ?? record.audioGroup }),
    };
  }

  private shakaKind(type: number, context?: any): RequestKind {
    // shaka.net.NetworkingEngine.RequestType: MANIFEST 0, SEGMENT 1, LICENSE 2, APP 3, TIMING 4
    const stream = context?.stream?.type;
    if (type === 0) {
      return this.sessionStart === undefined ? 'master' : stream === 'audio' ? 'audio-playlist' : stream === 'text' ? 'subtitle-playlist' : 'variant';
    }
    if (type === 1) {
      // InitSegmentReference has no getStartTime(); SegmentReference does.
      const isInit = !!context?.segment && typeof context.segment.getStartTime !== 'function';
      return isInit ? 'init' : stream === 'audio' ? 'audio-segment' : stream === 'text' ? 'subtitle-segment' : 'video-segment';
    }
    return 'other';
  }

  private trim(records: RequestRecord[]): RequestRecord[] {
    const masters = records.filter((record) => record.kind === 'master');
    const rest = records.filter((record) => record.kind !== 'master');
    return [...masters, ...rest.slice(rest.length - (MAX_RECORDS - masters.length))].sort((a, b) => a.id - b.id);
  }

  /** Fallback: fills timing, size and cache hints from Resource Timing when the loader could not supply them. */
  private startResourceObserver(): void {
    if (typeof PerformanceObserver === 'undefined') {
      return;
    }
    try {
      this.perfObserver = new PerformanceObserver((list) =>
        list.getEntries().forEach((entry) => this.applyResourceEntry(entry as PerformanceResourceTiming))
      );
      this.perfObserver.observe({ type: 'resource', buffered: false });
    } catch (e) {
      this.perfObserver = undefined;
    }
  }

  private applyResourceEntry(entry: PerformanceResourceTiming): void {
    const match = this.records.find(
      (record) =>
        !this.perfMatched.has(record.id) &&
        this.sameUrl(record.url, entry.name) &&
        Math.abs(record.tRequest - entry.startTime) <= PERF_MATCH_WINDOW_MS
    );
    if (!match) {
      return;
    }
    this.perfMatched.add(match.id);
    // Cross-origin resources without Timing-Allow-Origin report all sizes as 0: nothing to learn then.
    const hasSizes = entry.transferSize > 0 || entry.encodedBodySize > 0;
    const status = (entry as any).responseStatus;
    this.update(match.id, {
      tFirstByte: match.tFirstByte ?? (entry.responseStart > 0 ? entry.responseStart : undefined),
      tLoaded: match.tLoaded ?? (entry.responseEnd > 0 ? entry.responseEnd : undefined),
      bytes: match.bytes ?? (hasSizes ? entry.encodedBodySize : undefined),
      transferSize: hasSizes ? entry.transferSize : undefined,
      fromCache: match.fromCache ?? (hasSizes ? entry.transferSize === 0 : undefined),
      status: match.status ?? (status > 0 ? status : undefined),
    });
  }

  private sameUrl(a: string, b: string): boolean {
    try {
      return new URL(a, location.href).href === new URL(b, location.href).href;
    } catch (e) {
      return a === b;
    }
  }
}

/**
 * Parses XMLHttpRequest.getAllResponseHeaders() into a lower-cased map.
 * Browsers only expose CORS-safelisted headers plus those named in Access-Control-Expose-Headers for cross-origin
 * requests, so edge headers (e.g. X-Cache, X-Akamai-*, Server-Timing) are only visible if the CDN exposes them.
 */
export const parseResponseHeaders = (raw: string): Record<string, string> =>
  raw
    .trim()
    .split(/[\r\n]+/)
    .reduce<Record<string, string>>((headers, line) => {
      const idx = line.indexOf(':');
      return idx > 0 ? { ...headers, [line.slice(0, idx).trim().toLowerCase()]: line.slice(idx + 1).trim() } : headers;
    }, {});
