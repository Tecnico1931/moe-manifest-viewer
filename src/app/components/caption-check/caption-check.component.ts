import { ChangeDetectorRef, Component, Input, OnDestroy, OnInit, Optional } from '@angular/core';
import { Subscription } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { ViewerState } from '../../shared';
import { RequestLogService } from '../../shared/services/request-log.service';
import { parseMediaPlaylist } from '../audio-compare/audio-compare.logic';
import {
  analyseCues,
  audioCodecsForGroup,
  checkCaptionMedia,
  Cue,
  CueReport,
  cueIssues,
  formatSec,
  Issue,
  mapOffsetSec,
  MAX_SEGMENTS,
  MediaEntry,
  parseMasterMedia,
  parseVtt,
  VariantRef,
} from './caption-check.logic';

interface TrackResult {
  report?: CueReport;
  issues: Issue[];
  segmentsFetched: number;
  segmentsTotal: number;
  duration: number;
  error?: string;
}

interface CaptionRow {
  entry: MediaEntry;
  result?: TrackResult;
  busy?: boolean;
}

@Component({
  selector: 'app-caption-check',
  templateUrl: './caption-check.component.html',
  styleUrls: ['./caption-check.component.scss'],
})
export class CaptionCheckComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public captions: CaptionRow[] = [];
  public audio: Array<{ entry: MediaEntry; codecs: string[] }> = [];
  public issues: Issue[] = [];
  public status = '';
  public isChecking = false;
  public readonly maxSegments = MAX_SEGMENTS;
  public readonly formatSec = formatSec;

  private subs = new Subscription();
  private loadedMaster = '';
  private variants: VariantRef[] = [];

  constructor(@Optional() private requestLog: RequestLogService | null, private cdr: ChangeDetectorRef) {}

  public ngOnInit(): void {
    if (this.requestLog) {
      this.subs.add(
        this.requestLog.records$.subscribe((records) => {
          const master = records.find((r) => r.kind === 'master')?.url;
          if (master && master !== this.loadedMaster) {
            this.loadMaster(master);
          }
        })
      );
    }
    this.subs.add(
      this.viewerState.videoSource$
        .pipe(
          map((url) => url || ''),
          distinctUntilChanged()
        )
        .subscribe((url) => {
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
    const url = this.requestLog?.firstOf('master')?.url || this.viewerState.url || this.loadedMaster;
    if (url) {
      this.loadMaster(url);
    }
  }

  public get canCheck(): boolean {
    return !this.isChecking && this.captions.some((row) => row.entry.type === 'SUBTITLES' && !!row.entry.uri);
  }

  public async checkCues(): Promise<void> {
    if (!this.canCheck) {
      return;
    }
    this.isChecking = true;
    this.captions = this.captions.map((row) => ({ ...row, result: undefined, busy: row.entry.type === 'SUBTITLES' && !!row.entry.uri }));
    this.status = 'Fetching subtitle playlists';
    this.cdr.markForCheck();
    try {
      await Promise.all(
        this.captions.map(async (row, i) => {
          if (!row.busy) {
            return;
          }
          this.captions[i] = { ...row, busy: false, result: await this.checkTrack(row.entry) };
          this.cdr.markForCheck();
        })
      );
      this.status = '';
    } finally {
      this.isChecking = false;
      this.cdr.markForCheck();
    }
  }

  public trackByIndex = (i: number): number => i;

  private get credentials(): RequestCredentials {
    // The global token is stored as a cookie, so it rides along whenever credentials are included.
    return this.viewerState.xhrCredentials || this.viewerState.globalTokenActive ? 'include' : 'same-origin';
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, { credentials: this.credentials });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  }

  private async loadMaster(url: string): Promise<void> {
    this.loadedMaster = url;
    this.status = 'Loading master playlist';
    try {
      const master = parseMasterMedia(await this.fetchText(url), url);
      this.variants = master.variants;
      this.captions = master.media.filter((m) => m.type === 'SUBTITLES' || m.type === 'CLOSED-CAPTIONS').map((entry) => ({ entry }));
      this.audio = master.media
        .filter((m) => m.type === 'AUDIO')
        .map((entry) => ({ entry, codecs: audioCodecsForGroup(master.variants, entry.groupId) }));
      this.issues = checkCaptionMedia(master);
      this.status = master.media.length || master.variants.length ? '' : 'Not a master playlist (no EXT-X-MEDIA or EXT-X-STREAM-INF)';
    } catch (e) {
      this.captions = [];
      this.audio = [];
      this.issues = [];
      this.status = `Could not load master playlist (${e && (e as Error).message ? (e as Error).message : e})`;
    }
    this.cdr.markForCheck();
  }

  private async checkTrack(entry: MediaEntry): Promise<TrackResult> {
    const base: TrackResult = { issues: [], segmentsFetched: 0, segmentsTotal: 0, duration: 0 };
    try {
      const uri = entry.uri as string;
      const playlist = parseMediaPlaylist(await this.fetchText(uri), uri);
      const segments = playlist.segments.slice(0, MAX_SEGMENTS);
      const duration = playlist.segments.reduce((sum, s) => sum + s.duration, 0);
      const files = await Promise.all(segments.map((s) => this.fetchText(s.url).then(parseVtt, () => undefined)));
      const ok = files.filter((f): f is NonNullable<typeof f> => !!f && f.isWebVtt);
      const cues = ok.reduce<Cue[]>((acc, f) => [...acc, ...f.cues], []);
      const report = analyseCues(cues);
      const isPartial = playlist.segments.length > segments.length;
      const found = cueIssues(
        report,
        {
          present: ok.filter((f) => !!f.timestampMap).length,
          total: ok.length,
          offsetsSec: ok.filter((f) => !!f.timestampMap).map((f) => mapOffsetSec(f.timestampMap)),
        },
        duration || undefined,
        isPartial
      );
      const skipped = files.length - ok.length;
      const extra: Issue[] = [];
      if (!playlist.segments.length) {
        extra.push({ severity: 'error', message: 'Subtitle playlist has no segments' });
      }
      if (skipped) {
        extra.push({ severity: 'warn', message: `${skipped} segment(s) failed to load or are not WebVTT` });
      }
      if (isPartial) {
        extra.push({ severity: 'info', message: `Checked the first ${segments.length} of ${playlist.segments.length} segments` });
      }
      return {
        ...base,
        report,
        issues: [...extra, ...found],
        segmentsFetched: ok.length,
        segmentsTotal: playlist.segments.length,
        duration,
      };
    } catch (e) {
      return { ...base, error: e && (e as Error).message ? (e as Error).message : String(e) };
    }
  }
}
