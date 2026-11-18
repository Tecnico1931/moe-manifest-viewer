import { ChangeDetectorRef, Component, Input, OnDestroy, OnInit, Optional } from '@angular/core';
import { Subscription } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { ViewerState } from '../../shared';
import { RequestLogService } from '../../shared/services/request-log.service';
import {
  AudioRendition,
  extractAdtsFromTs,
  formatDb,
  isMpegTs,
  lufsBarPercent,
  LufsSpread,
  lufsSpread,
  measuredKbpsByTrack,
  measureTrack,
  MediaPlaylist,
  parseMasterAudio,
  parseMediaPlaylist,
  pickSegmentIndex,
  PlaylistSegment,
  TrackMeasurement,
} from './audio-compare.logic';

interface TrackRow {
  rendition: AudioRendition;
  kbps?: number;
  kbpsSegments?: number;
  measurement?: TrackMeasurement;
  error?: string;
  busy?: boolean;
}

@Component({
  selector: 'app-audio-compare',
  templateUrl: './audio-compare.component.html',
  styleUrls: ['./audio-compare.component.scss'],
})
export class AudioCompareComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public rows: TrackRow[] = [];
  public masterUrl = '';
  public status = '';
  public isAnalysing = false;
  public segmentIndex?: number;
  public analysedIndex?: number;
  public analysedSeconds?: number;
  public spread?: LufsSpread;
  public readonly formatDb = formatDb;
  public readonly lufsBarPercent = lufsBarPercent;

  private subs = new Subscription();
  private loadedMaster = '';

  constructor(@Optional() private requestLog: RequestLogService | null, private cdr: ChangeDetectorRef) {}

  public ngOnInit(): void {
    if (this.requestLog) {
      this.subs.add(
        this.requestLog.records$.subscribe((records) => {
          const master = records.find((r) => r.kind === 'master')?.url;
          if (master && master !== this.loadedMaster) {
            this.loadMaster(master);
          }
          this.applyMeasuredKbps();
        })
      );
    }
    this.subs.add(
      this.viewerState.videoSource$.pipe(map((url) => url || ''), distinctUntilChanged()).subscribe((url) => {
        if (url && !this.requestLog?.firstOf('master') && url !== this.loadedMaster) {
          this.loadMaster(url);
        }
      })
    );
  }

  public ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  public reload(): void {
    const url = this.requestLog?.firstOf('master')?.url || this.viewerState.url || this.masterUrl;
    if (url) {
      this.loadMaster(url);
    }
  }

  public get canAnalyse(): boolean {
    return !this.isAnalysing && this.rows.some((row) => !!row.rendition.uri);
  }

  public get spreadText(): string {
    return this.spread ? `${this.spread.spread.toFixed(1)} LU` : '—';
  }

  public get resultLabel(): string {
    return this.analysedIndex === undefined
      ? ''
      : `Segment ${this.analysedIndex + 1} (${(this.analysedSeconds ?? 0).toFixed(1)}s), not the whole programme`;
  }

  public onSegmentInput(value: string): void {
    const n = parseInt(value, 10);
    this.segmentIndex = isFinite(n) && n >= 1 ? n - 1 : undefined;
  }

  public async analyse(): Promise<void> {
    if (!this.canAnalyse) {
      return;
    }
    this.isAnalysing = true;
    this.spread = undefined;
    this.rows = this.rows.map((row) => ({ ...row, measurement: undefined, error: undefined, busy: !!row.rendition.uri }));
    this.status = 'Fetching playlists';
    this.cdr.markForCheck();
    const AudioCtx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = AudioCtx ? new AudioCtx() : undefined;
    try {
      const playlists = await Promise.all(this.rows.map((row) => this.fetchPlaylist(row)));
      const reference = playlists.find((p) => p && p.segments.length);
      const index = this.segmentIndex ?? pickSegmentIndex(reference ? reference.segments : [], this.playhead());
      this.analysedIndex = index;
      this.status = `Decoding segment ${index + 1}`;
      await Promise.all(
        this.rows.map(async (row, i) => {
          this.rows[i] = await this.analyseRow(row, playlists[i], index, ctx);
          this.cdr.markForCheck();
        })
      );
      const durations = this.rows.map((row) => row.measurement?.durationSec).filter((d): d is number => d !== undefined);
      this.analysedSeconds = durations.length ? Math.max(...durations) : 0;
      this.spread = lufsSpread(this.rows.map((row) => (row.measurement ? row.measurement.lufs : NaN)));
      this.status = '';
    } catch (e) {
      this.status = `Analyse failed: ${e && (e as Error).message ? (e as Error).message : e}`;
    } finally {
      this.isAnalysing = false;
      this.rows = this.rows.map((row) => ({ ...row, busy: false }));
      if (ctx && ctx.state !== 'closed') {
        ctx.close().catch(() => undefined);
      }
      this.cdr.markForCheck();
    }
  }

  public trackByName = (_: number, row: TrackRow): string => `${row.rendition.groupId}/${row.rendition.name}`;

  private playhead(): number | undefined {
    const video = this.viewerState.videoElement;
    return video && video.currentTime > 0 ? video.currentTime : this.viewerState.currentTime;
  }

  private get credentials(): RequestCredentials {
    // The global token is stored as a cookie, so it rides along whenever credentials are included.
    return this.viewerState.xhrCredentials || this.viewerState.globalTokenActive ? 'include' : 'same-origin';
  }

  private async fetchBytes(url: string, range?: { length: number; offset?: number }): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (range) {
      const start = range.offset ?? 0;
      headers.Range = `bytes=${start}-${start + range.length - 1}`;
    }
    const response = await fetch(url, { credentials: this.credentials, headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  }

  private async fetchText(url: string): Promise<string> {
    return new TextDecoder().decode(await this.fetchBytes(url));
  }

  private async loadMaster(url: string): Promise<void> {
    this.loadedMaster = url;
    this.masterUrl = url;
    this.status = 'Loading master playlist';
    try {
      const renditions = parseMasterAudio(await this.fetchText(url), url);
      this.rows = renditions.map((rendition) => ({ rendition }));
      this.status = renditions.length ? '' : 'No EXT-X-MEDIA TYPE=AUDIO renditions in this playlist';
      this.applyMeasuredKbps();
    } catch (e) {
      this.rows = [];
      this.status = `Could not load master playlist (${e && (e as Error).message ? (e as Error).message : e})`;
    }
    this.cdr.markForCheck();
  }

  private applyMeasuredKbps(): void {
    if (!this.requestLog || !this.rows.length) {
      return;
    }
    const measured = measuredKbpsByTrack(this.requestLog.byKind('audio-segment'));
    const next = this.rows.map((row) => {
      const m = measured[row.rendition.name];
      return m ? { ...row, kbps: m.kbps, kbpsSegments: m.segments } : row;
    });
    const changed = next.some((row, i) => row.kbps !== this.rows[i].kbps || row.kbpsSegments !== this.rows[i].kbpsSegments);
    if (changed) {
      this.rows = next;
      this.cdr.markForCheck();
    }
  }

  private async fetchPlaylist(row: TrackRow): Promise<MediaPlaylist | undefined> {
    if (!row.rendition.uri) {
      return undefined;
    }
    try {
      return parseMediaPlaylist(await this.fetchText(row.rendition.uri), row.rendition.uri);
    } catch (e) {
      return undefined;
    }
  }

  private async analyseRow(row: TrackRow, playlist: MediaPlaylist | undefined, index: number, ctx?: AudioContext): Promise<TrackRow> {
    const fail = (error: string): TrackRow => ({ ...row, busy: false, error });
    if (!row.rendition.uri) {
      return fail('No URI (muxed in the main stream)');
    }
    if (!playlist) {
      return fail('Playlist fetch failed');
    }
    const segment: PlaylistSegment | undefined = playlist.segments[Math.min(index, playlist.segments.length - 1)];
    if (!segment) {
      return fail('Empty playlist');
    }
    if (!ctx) {
      return fail('Web Audio not available');
    }
    try {
      const body = new Uint8Array(await this.fetchBytes(segment.url, segment.byteRange));
      let decodable: Uint8Array = body;
      if (isMpegTs(body)) {
        const adts = extractAdtsFromTs(body);
        if (!adts) {
          return fail('TS audio is not AAC/MP3 (e.g. AC-3): cannot decode');
        }
        decodable = adts;
      } else if (playlist.mapUrl) {
        const init = new Uint8Array(await this.fetchBytes(playlist.mapUrl, playlist.mapByteRange));
        decodable = new Uint8Array(init.length + body.length);
        decodable.set(init, 0);
        decodable.set(body, init.length);
      }
      const copy = decodable.buffer.slice(decodable.byteOffset, decodable.byteOffset + decodable.byteLength) as ArrayBuffer;
      const buffer = await ctx.decodeAudioData(copy);
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      return { ...row, busy: false, measurement: measureTrack(channels, buffer.sampleRate) };
    } catch (e) {
      const message = e && (e as Error).message ? (e as Error).message : 'decode failed';
      return fail(`Decode failed: ${message}`);
    }
  }
}
