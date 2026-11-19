import type { RequestKind } from '../../shared/services/request-log.service';

/** Pure helpers for the Video.js player (no DOM, no video.js), so they can be tested with node. */

export type VideojsSourceType = 'application/x-mpegURL' | 'application/dash+xml';

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.split(/[?#]/)[0].toLowerCase();
  }
};

/** Video.js (VHS) needs the MIME type; .mpd is DASH, anything else is treated as HLS. */
export function sourceTypeFor(url: string): VideojsSourceType {
  return pathOf(url).endsWith('.mpd') ? 'application/dash+xml' : 'application/x-mpegURL';
}

const AUDIO = /(^|[/_\-.])(audio|aac|mp4a|ac-?3|ec-?3)([/_\-.]|\d|$)/;
const TEXT = /(^|[/_\-.])(subtitles?|captions?|text|vtt|webvtt)([/_\-.]|\d|$)/;

/**
 * Best-effort request kind from the URL alone: VHS's xhr hooks don't say which playlist or
 * stream a request belongs to. Only the path is checked, so a host or token can't mislead it.
 */
export function requestKindFor(url: string, isFirstPlaylist: boolean): RequestKind {
  const path = pathOf(url);
  const file = path.split('/').pop() || '';
  if (/\.(m3u8|mpd)$/.test(file)) {
    if (isFirstPlaylist) {
      return 'master';
    }
    return AUDIO.test(path) ? 'audio-playlist' : TEXT.test(path) ? 'subtitle-playlist' : 'variant';
  }
  if (/\.(vtt|webvtt|srt|ttml|dfxp)$/.test(file)) {
    return 'subtitle-segment';
  }
  if (/init/.test(file) && /\.(mp4|m4s|m4v|m4a|cmfv|cmfa)$/.test(file)) {
    return 'init';
  }
  if (/\.(ts|m4s|mp4|m4v|m4a|aac|mp3|ac3|ec3|cmfv|cmfa)$/.test(file)) {
    return AUDIO.test(path) || /\.(aac|m4a|mp3|ac3|ec3|cmfa)$/.test(file) ? 'audio-segment' : 'video-segment';
  }
  return 'other';
}

export interface BitrateLevel {
  bitrate: number;
}

/** Unique positive bitrates, ascending, for the quality menu. */
export function uniqueBitrates(levels: BitrateLevel[]): number[] {
  return [...new Set(levels.map((level) => Number(level.bitrate)).filter((b) => b > 0))].sort((a, b) => a - b);
}

/**
 * Which quality levels to keep enabled. null means auto (all on). A bitrate that matches no level
 * leaves all on, because disabling every level would stop playback.
 */
export function levelsToEnable(levels: BitrateLevel[], bitrate: number | null): boolean[] {
  if (bitrate === null || !levels.some((level) => Number(level.bitrate) === Number(bitrate))) {
    return levels.map(() => true);
  }
  return levels.map((level) => Number(level.bitrate) === Number(bitrate));
}
