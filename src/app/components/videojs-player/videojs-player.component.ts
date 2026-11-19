import { Component, ElementRef, Input, NgZone, OnDestroy, OnInit, Output, EventEmitter, ViewChild } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { BehaviorSubject, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AppService, ViewerState } from 'src/app/shared';
import { VideoPlayers } from '../../shared/models/video-players';
import { RequestLogService } from '../../shared/services/request-log.service';
import { isTokenExpired } from '../../shared/token-safety.logic';
import { levelsToEnable, requestKindFor, sourceTypeFor, uniqueBitrates } from './videojs-player.logic';

/**
 * Video.js 8 (VHS) player. The library is loaded from jsDelivr only when this player is picked
 * (window.getVideojsLibrary in index.html), so it adds nothing to the page size.
 */
@Component({
  selector: 'app-videojs-player',
  templateUrl: './videojs-player.component.html',
  styleUrls: ['./videojs-player.component.scss'],
})
export class VideojsPlayerComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;
  @Input() public width: number;

  @Output() public onBitrateList: EventEmitter<any> = new EventEmitter<any>();

  @ViewChild('playerContainer', { static: true }) public playerContainer: ElementRef<HTMLElement>;

  public bitratesList$: BehaviorSubject<number[]> = new BehaviorSubject<number[]>([]);
  public currentBitrate = 0;
  public isAuto = true;
  public muted = false;
  public volume = 1;
  public version = 'video.js';
  public height: number;
  public showTopBar = false;

  private videojs: any;
  private player: any;
  private currentSource: string;
  private ngUnsubscribe: Subject<void> = new Subject<void>();
  private seenPlaylist = false;
  private openRequests = new Map<string, number[]>();

  constructor(
    public appService: AppService,
    private toastrService: ToastrService,
    private requestLog: RequestLogService,
    private zone: NgZone
  ) {}

  public ngOnInit(): void {
    const load = (<any>window).getVideojsLibrary;
    if (typeof load !== 'function') {
      this.toastrService.error('Video.js loader missing from the page', 'Video.js');
      return;
    }
    load()
      .then(() => {
        this.videojs = (<any>window).videojs;
        if (!this.videojs) {
          throw new Error('window.videojs not defined');
        }
        this.version = `video.js ${this.videojs.VERSION}`;
        this.height = this.playerContainer.nativeElement.offsetHeight;
        this.appService.muteVideo$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.switchMuted);
        this.viewerState.videoSource$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.loadSource);
      })
      .catch(() => this.toastrService.error('Could not load Video.js from cdn.jsdelivr.net', 'Video.js'));
  }

  public ngOnDestroy(): void {
    this.ngUnsubscribe.next();
    this.ngUnsubscribe.complete();
    this.disposePlayer();
  }

  public toggleTopBar = (show: boolean): void => {
    this.showTopBar = show;
  };

  public switchMuted = (muted: boolean): void => {
    this.muted = muted;
    this.player?.muted(muted);
    this.viewerState.setMuteVideo(muted);
  };

  /** Quality menu: keep only the levels with this bitrate. */
  public setQualityByBitrate = (bitrate: number | string): void => {
    this.applyLevels(Number(bitrate));
  };

  /** Quality menu "auto": all levels back on. */
  public setABR = (): void => {
    this.applyLevels(null);
  };

  private loadSource = (source: string): void => {
    if (!source || !this.videojs) {
      return;
    }
    this.currentSource = source;
    this.viewerState.setCurrentSource(source);
    this.initPlayer(source);
  };

  private initPlayer(source: string): void {
    this.disposePlayer();
    this.seenPlaylist = false;
    this.isAuto = true;

    // Video.js removes its element on dispose, so make a fresh one each time.
    const el = document.createElement('video-js');
    el.className = 'video-js vjs-fill';
    el.setAttribute('playsinline', '');
    this.playerContainer.nativeElement.appendChild(el);

    const options = {
      autoplay: true,
      controls: true,
      muted: this.muted,
      liveui: true,
      // VHS everywhere (also Safari) so quality levels and request hooks work the same in every browser.
      html5: { vhs: { overrideNative: true }, nativeAudioTracks: false, nativeVideoTracks: false },
      ...this.userConfig(),
    };
    this.player = this.videojs(el, options);
    this.player.on('xhr-hooks-ready', this.attachRequestHooks);
    this.bindPlayerEvents();
    this.player.src({ src: source, type: sourceTypeFor(source) });
  }

  /** Player config saved in the Player Config panel is passed through as Video.js options. */
  private userConfig(): object {
    const raw = this.viewerState.playerConfigs?.[VideoPlayers.VIDEOJS_PLAYER];
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      this.toastrService.warning('Video.js player config is not valid JSON; ignored', 'Video.js');
      return {};
    }
  }

  private bindPlayerEvents(): void {
    const p = this.player;
    ['pause', 'playing', 'waiting', 'seeking', 'ended'].forEach((state) => p.on(state, () => this.viewerState.setPlayerState(state)));
    p.on('durationchange', () => this.viewerState.setVideoDuration(p.duration()));
    p.on('timeupdate', () => this.viewerState.displayTime(p.currentTime()));
    p.on('volumechange', () => {
      this.volume = p.volume();
      if (p.muted() !== this.muted) {
        this.appService.toggleMuteVideo(p.muted());
      }
    });
    p.on('loadedmetadata', () => {
      this.viewerState.updateIsLive(!!p.liveTracker?.isLive());
      this.emitBitrates();
    });
    p.on('error', this.onError);

    const levels = p.qualityLevels?.();
    if (levels) {
      levels.on('addlevel', this.emitBitrates);
      levels.on('change', () => {
        this.emitBitrates();
        const active = levels[levels.selectedIndex];
        if (active) {
          this.currentBitrate = Number(active.bitrate) || 0;
          this.viewerState.updateBandwidth(String(this.currentBitrate));
          this.viewerState.onBandwidthUpdated(this.currentBitrate);
          this.viewerState.currentWidth = active.width ?? -1;
          this.viewerState.currentHeight = active.height ?? -1;
        }
      });
    }
  }

  /** Called on addlevel, loadedmetadata and level change; only emits when the list changed. */
  private emitBitrates = (): void => {
    const next = uniqueBitrates(this.levelList());
    if (next.join() === this.bitratesList$.value.join()) {
      return;
    }
    this.zone.run(() => {
      this.bitratesList$.next(next);
      this.onBitrateList.emit(this.bitratesList$);
    });
  };

  private levelList(): any[] {
    const levels = this.player?.qualityLevels?.();
    return levels ? Array.from({ length: levels.length }, (_, i) => levels[i]) : [];
  }

  private applyLevels(bitrate: number | null): void {
    const list = this.levelList();
    levelsToEnable(list, bitrate).forEach((on, i) => (list[i].enabled = on));
    this.isAuto = bitrate === null;
    if (bitrate !== null) {
      this.currentBitrate = bitrate;
    }
  }

  /** VHS request hooks feed the shared request log (Startup, Akamai Edge, report panels). Best effort. */
  private attachRequestHooks = (): void => {
    const xhr = this.player?.tech?.({ IWillNotUseThisInPlugins: true })?.vhs?.xhr;
    if (!xhr?.onRequest || !xhr?.onResponse) {
      return;
    }
    xhr.onRequest((options: any) => {
      const url = options?.uri;
      if (url) {
        const isPlaylist = /\.(m3u8|mpd)(\?|#|$)/i.test(url);
        const kind = requestKindFor(url, isPlaylist && !this.seenPlaylist);
        this.seenPlaylist = this.seenPlaylist || isPlaylist;
        const id = this.requestLog.begin({ url, kind });
        this.openRequests.set(url, [...(this.openRequests.get(url) || []), id]);
      }
      return options;
    });
    xhr.onResponse((request: any, error: any, response: any) => {
      const url = request?.uri;
      const ids = url ? this.openRequests.get(url) : undefined;
      const id = ids?.shift();
      if (id === undefined) {
        return;
      }
      const body = response?.body;
      this.requestLog.update(id, {
        status: response?.statusCode,
        headers: response?.headers,
        bytes: body?.byteLength ?? (typeof body === 'string' ? body.length : undefined),
        tLoaded: performance.now(),
      });
      if (/\.(ts|m4s|mp4|aac)(\?|#|$)/i.test(url)) {
        const frag = url.split(/[?#]/)[0].split('/').pop();
        if (frag) {
          this.viewerState.setFragUrlChanged(frag);
        }
      }
    });
  };

  private onError = (): void => {
    const err = this.player?.error?.();
    const message = err?.message || 'Playback error';
    if (isTokenExpired(this.currentSource || '', Date.now())) {
      this.toastrService.error('Token expired — get a new URL', 'Video.js');
      return;
    }
    this.toastrService.error(message, `Video.js error ${err?.code ?? ''}`.trim());
  };

  private disposePlayer(): void {
    if (this.player) {
      this.player.dispose();
      this.player = undefined;
    }
    this.openRequests.clear();
    this.bitratesList$.next([]);
  }
}
