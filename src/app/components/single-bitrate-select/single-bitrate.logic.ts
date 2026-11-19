/**
 * Peloton single-bitrate EdgeWorker (akamai-edgeworkers/single-bitrate): a `rendition` query param on the
 * master manifest makes the edge return one video variant. Keys map to a target height; the edge picks the
 * nearest height if that one is missing. Unknown or empty keys fall back to 720p at the edge.
 */
export interface SingleBitrateOption {
  key: string;
  label: string;
}

export const SINGLE_BITRATE_OPTIONS: SingleBitrateOption[] = [
  { key: '', label: 'Full ladder' },
  { key: 'hd', label: 'Single: hd (1080p)' },
  { key: 'sd', label: 'Single: sd (720p)' },
  { key: 'lb', label: 'Single: lb (540p)' },
];

const PARAM = /([?&])rendition=[^&#]*(&?)/i;

/** The `rendition` value in a URL, lower-cased, or '' when absent. */
export function readRendition(url: string): string {
  const m = (url || '').match(/[?&]rendition=([^&#]*)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

/**
 * Set or remove `rendition` without re-encoding the rest of the query, so signed token params
 * (hdnts=exp=...~acl=...~hmac=...) stay byte-for-byte the same.
 */
export function withRendition(url: string, key: string): string {
  if (!url) {
    return url;
  }
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  let base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  while (PARAM.test(base)) {
    base = base.replace(PARAM, (_all, sep: string, next: string) => (next ? sep : ''));
  }
  if (key) {
    base += (base.indexOf('?') >= 0 ? '&' : '?') + 'rendition=' + encodeURIComponent(key);
  }
  return base + hash;
}
