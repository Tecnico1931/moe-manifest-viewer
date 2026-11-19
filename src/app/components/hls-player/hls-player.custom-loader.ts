import * as HlsTypes from 'hls.js';
import { BeginInit, RequestLogService, RequestRecord, parseResponseHeaders } from '../../shared/services/request-log.service';
import { summarizePlaylist } from '../live-mode/live-mode.logic';

const AGE_HEADER_LINE_REGEX = /^age:\s*[\d.]+\s*$/m;

class LoadStats implements HlsTypes.LoaderStats {
  aborted: boolean = false;
  loaded: number = 0;
  retry: number = 0;
  total: number = 0;
  chunkCount: number = 0;
  bwEstimate: number = 0;
  loading: HlsTypes.HlsProgressivePerformanceTiming = { start: 0, first: 0, end: 0 };
  parsing: HlsTypes.HlsPerformanceTiming = { start: 0, end: 0 };
  buffering: HlsTypes.HlsProgressivePerformanceTiming = { start: 0, first: 0, end: 0 };
}

/** Maps an hls.js loader context (playlist, fragment or key) onto the request log's kind and metadata. */
const classifyContext = (context: HlsTypes.LoaderContext): Omit<BeginInit, 'url'> => {
  const ctx = context as any;
  if (ctx.keyInfo) {
    return { kind: 'key', sn: typeof ctx.frag?.sn === 'number' ? ctx.frag.sn : undefined };
  }
  if (ctx.frag) {
    const frag = ctx.frag;
    // hls.js 1.3 loads the EXT-X-MAP init segment as a fragment with sn 0 and no EXTINF duration (not 'initSegment').
    const isInit = frag.sn === 'initSegment' || !frag.duration;
    const sn = typeof frag.sn === 'number' ? frag.sn : undefined;
    const durationSec = isInit ? undefined : frag.duration;
    if (frag.type === 'audio') {
      return { kind: isInit ? 'init' : 'audio-segment', audioTrackId: frag.level, sn, durationSec };
    }
    if (frag.type === 'subtitle') {
      return { kind: 'subtitle-segment', sn, durationSec };
    }
    return { kind: isInit ? 'init' : 'video-segment', level: frag.level, sn, durationSec };
  }
  switch (ctx.type) {
    case 'manifest':
      return { kind: 'master' };
    case 'level':
      return { kind: 'variant', level: ctx.level ?? undefined };
    case 'audioTrack':
      return { kind: 'audio-playlist', audioTrackId: ctx.id ?? undefined, audioGroup: ctx.groupId ?? undefined };
    case 'subtitleTrack':
      return { kind: 'subtitle-playlist' };
    default:
      return { kind: 'other' };
  }
};

export class customXhrLoader implements HlsTypes.Loader<HlsTypes.LoaderContext> {
  private xhrSetup: Function | null;
  private requestTimeout?: number;
  private retryTimeout?: number;
  private retryDelay: number;
  private config: HlsTypes.LoaderConfiguration | null = null;
  private callbacks: HlsTypes.LoaderCallbacks<HlsTypes.LoaderContext> | null = null;
  public context!: HlsTypes.LoaderContext;

  private loader: XMLHttpRequest | null = null;
  public stats: HlsTypes.LoaderStats;

  /** Set by subclasses made with createRecordingLoader; when present every request is logged. */
  protected requestLog?: RequestLogService;
  private requestId?: number;

  constructor(config /* HlsConfig */) {
    this.xhrSetup = config ? config.xhrSetup : null;
    this.stats = new LoadStats();
    this.retryDelay = 0;
  }

  destroy(): void {
    this.callbacks = null;
    this.abortInternal();
    this.loader = null;
    this.config = null;
  }

  abortInternal(): void {
    const loader = this.loader;
    self.clearTimeout(this.requestTimeout);
    self.clearTimeout(this.retryTimeout);
    if (loader) {
      loader.onreadystatechange = null;
      loader.onprogress = null;
      if (loader.readyState !== 4) {
        this.stats.aborted = true;
        loader.abort();
      }
    }
  }

  abort(): void {
    this.abortInternal();
    if (this.stats.aborted) {
      this.logUpdate({ error: 'aborted', tLoaded: self.performance.now() });
    }
    if (this.callbacks?.onAbort) {
      this.callbacks.onAbort(this.stats, this.context, this.loader);
    }
  }

  load(
    context: HlsTypes.LoaderContext,
    config: HlsTypes.LoaderConfiguration,
    callbacks: HlsTypes.LoaderCallbacks<HlsTypes.LoaderContext>
  ): void {
    if (this.stats.loading.start) {
      throw new Error('Loader can only be used once.');
    }
    this.stats.loading.start = self.performance.now();
    this.context = context;
    this.config = config;
    this.callbacks = callbacks;
    this.retryDelay = config.retryDelay;
    this.logStart();
    this.loadInternal();
  }

  loadInternal(): void {
    const { config, context } = this;
    if (!config) {
      return;
    }
    const xhr = (this.loader = new XMLHttpRequest());

    const stats = this.stats;
    stats.loading.first = 0;
    stats.loaded = 0;
    const xhrSetup = this.xhrSetup;

    try {
      if (xhrSetup) {
        try {
          xhrSetup(xhr, context.url, context.headers);
        } catch (e) {
          // fix xhrSetup: (xhr, url) => {xhr.setRequestHeader("Content-Language", "test");}
          // not working, as xhr.setRequestHeader expects xhr.readyState === OPEN
          xhr.open('GET', context.url, true);
          xhrSetup(xhr, context.url, context.headers);
        }
      }
      if (!xhr.readyState) {
        xhr.open('GET', context.url, true);
      }
      if (context.headers) {
        for (const header in context.headers) {
          xhr.setRequestHeader(header, context.headers[header]);
        }
      }
    } catch (e) {
      // IE11 throws an exception on xhr.open if attempting to access an HTTP resource over HTTPS
      this.logUpdate({ error: e.message, tLoaded: self.performance.now() });
      this.callbacks!.onError({ code: xhr.status, text: e.message }, context, xhr);
      return;
    }

    if (context.rangeEnd) {
      xhr.setRequestHeader('Range', 'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1));
    }

    xhr.onreadystatechange = this.readystatechange.bind(this);
    xhr.onprogress = this.loadprogress.bind(this);
    xhr.responseType = context.responseType as XMLHttpRequestResponseType;
    // setup timeout before we perform request
    self.clearTimeout(this.requestTimeout);
    this.requestTimeout = self.setTimeout(this.loadtimeout.bind(this), config.timeout);
    xhr.send();
  }

  readystatechange(): void {
    const { context, loader: xhr, stats } = this;
    if (!context || !xhr) {
      return;
    }
    const readyState = xhr.readyState;
    const config = this.config as HlsTypes.LoaderConfiguration;

    // don't proceed if xhr has been aborted
    if (stats.aborted) {
      return;
    }

    // >= HEADERS_RECEIVED
    if (readyState >= 2) {
      // clear xhr timeout and rearm it if readyState less than 4
      self.clearTimeout(this.requestTimeout);
      if (stats.loading.first === 0) {
        stats.loading.first = Math.max(self.performance.now(), stats.loading.start);
        // Only CORS-exposed headers are readable here (see parseResponseHeaders).
        this.logUpdate({ tFirstByte: stats.loading.first, status: xhr.status, headers: parseResponseHeaders(xhr.getAllResponseHeaders()) });
      }

      if (readyState === 4) {
        xhr.onreadystatechange = null;
        xhr.onprogress = null;
        const status = xhr.status;
        // http status between 200 to 299 are all successful
        const isArrayBuffer = xhr.responseType === 'arraybuffer';
        if (status >= 200 && status < 300 && ((isArrayBuffer && xhr.response) || xhr.responseText !== null)) {
          stats.loading.end = Math.max(self.performance.now(), stats.loading.first);
          let data;
          let len: number;
          if (isArrayBuffer) {
            data = xhr.response;
            len = data.byteLength;
          } else {
            data = xhr.responseText;
            len = data.length;
          }
          stats.loaded = stats.total = len;
          this.logUpdate({ tLoaded: stats.loading.end, bytes: len, status, error: undefined, ...this.playlistDigest(data) });
          if (!isArrayBuffer && (context as any).type === 'manifest') {
            this.requestLog?.setMasterText(data);
          }

          if (!this.callbacks) {
            return;
          }
          const onProgress = this.callbacks.onProgress;
          if (onProgress) {
            onProgress(stats, context, data, xhr);
          }
          if (!this.callbacks) {
            return;
          }
          const response = {
            url: xhr.responseURL,
            data: data,
          };

          this.callbacks.onSuccess(response, stats, context, xhr);
        } else {
          this.logUpdate({ status, error: xhr.statusText || `HTTP ${status}`, tLoaded: self.performance.now() });
          // if max nb of retries reached or if http status between 400 and 499 (such error cannot be recovered, retrying is useless), return error
          if (stats.retry >= config.maxRetry || (status >= 400 && status < 499)) {
            this.callbacks!.onError({ code: status, text: xhr.statusText }, context, xhr);
          } else {
            // retry
            // abort and reset internal state
            this.abortInternal();
            this.loader = null;
            // schedule retry
            self.clearTimeout(this.retryTimeout);
            this.retryTimeout = self.setTimeout(this.loadInternal.bind(this), this.retryDelay);
            // set exponential backoff
            this.retryDelay = Math.min(2 * this.retryDelay, config.maxRetryDelay);
            stats.retry++;
          }
        }
      } else {
        // readyState >= 2 AND readyState !==4 (readyState = HEADERS_RECEIVED || LOADING) rearm timeout as xhr not finished yet
        self.clearTimeout(this.requestTimeout);
        this.requestTimeout = self.setTimeout(this.loadtimeout.bind(this), config.timeout);
      }
    }
  }

  loadtimeout(): void {
    const callbacks = this.callbacks;
    if (callbacks) {
      this.abortInternal();
      this.logUpdate({ error: 'timeout', tLoaded: self.performance.now() });
      callbacks.onTimeout(this.stats, this.context, this.loader);
    }
  }

  loadprogress(event: ProgressEvent): void {
    const stats = this.stats;

    stats.loaded = event.loaded;
    if (event.lengthComputable) {
      stats.total = event.total;
    }
  }

  getCacheAge(): number | null {
    let result: number | null = null;
    if (this.loader && AGE_HEADER_LINE_REGEX.test(this.loader.getAllResponseHeaders())) {
      const ageHeader = this.loader.getResponseHeader('age');
      result = ageHeader ? parseFloat(ageHeader) : null;
    }
    return result;
  }

  private logStart(): void {
    if (this.requestLog) {
      const { url } = this.context;
      this.requestId = this.requestLog.begin({ url, tRequest: this.stats.loading.start, ...classifyContext(this.context) });
    }
  }

  /** Variant playlists only: a small digest for the Live panel. Never throws. */
  private playlistDigest(data: unknown): Partial<RequestRecord> {
    if (!this.requestLog || typeof data !== 'string' || (this.context as any).type !== 'level') {
      return {};
    }
    const playlist = summarizePlaylist(data);
    return playlist ? { playlist } : {};
  }

  private logUpdate(patch: Partial<RequestRecord>): void {
    if (this.requestLog && this.requestId !== undefined) {
      this.requestLog.update(this.requestId, patch);
    }
  }
}

/** Returns a loader class (for hls.js `config.loader`) that logs every request into `requestLog`. */
export const createRecordingLoader = (requestLog: RequestLogService): typeof customXhrLoader =>
  class extends customXhrLoader {
    protected requestLog = requestLog;
  };
