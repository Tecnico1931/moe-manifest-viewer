/** Akamai token auth helpers (hdnts / hdntl). Pure; never logs or stores tokens. */

export interface TokenInfo {
  name: 'hdnts' | 'hdntl';
  /** expiry, unix seconds */
  exp?: number;
  /** start time, unix seconds */
  st?: number;
  /** access control list, never contains the hmac */
  acl?: string;
}

export type TokenState = 'ok' | 'warn' | 'expired';

export const TOKEN_WARN_SECONDS = 120;

const HMAC = '~hmac=[0-9a-fA-F]+';
const ENC_HMAC = '(?:~|%7[Ee])hmac(?:=|%3[Dd])[0-9a-fA-F]+';

/** query param, raw (?hdnts=...&) or percent-encoded inside another URL (%3Fhdnts%3D...%26) */
const QUERY_RE = /(\?|&|%3[Ff]|%26)(?:hdnts|hdntl)(?:=|%3[Dd])[^&#\s]*?(&|%26|(?=#|%23|\s|$))/gi;
/** path segment, raw: /hdntl=exp=..~acl=/a/*~hmac=hex  (acl may contain slashes) */
const PATH_RE = new RegExp(`/hdnt[sl]=(?:[^?#\\s]*?${HMAC}|[^/?#&\\s]*)`, 'gi');
/** path segment inside a percent-encoded URL */
const ENC_PATH_RE = new RegExp(`%2[Ff]hdnt[sl](?:=|%3[Dd])(?:[^?#&\\s]*?${ENC_HMAC}|(?:(?!%2[Ff]|%3[Ff]|%23|%26)[^\\s&#?/])*)`, 'gi');

const isEncoded = (s: string): boolean => s.charAt(0) === '%';
const isQuestion = (s: string): boolean => s === '?' || /^%3f$/i.test(s);

/** Remove Akamai token params / path segments from a URL (raw or percent-encoded). */
export const redactTokens = (url: string): string => {
  if (!url) {
    return url;
  }
  const stripQuery = (u: string): string =>
    u.replace(QUERY_RE, (_m: string, sep: string, next: string) => {
      if (!next) {
        return '';
      }
      if (isEncoded(next) !== isEncoded(sep)) {
        return next; // next separator belongs to an outer level; token was last at this level
      }
      return isQuestion(sep) ? sep : next;
    });
  let out = url;
  for (let prev = ''; prev !== out; ) {
    // repeat: back-to-back tokens share a separator, which the first match consumes
    prev = out;
    out = stripQuery(out);
  }
  return out.replace(PATH_RE, '').replace(ENC_PATH_RE, '');
};

export const hasToken = (url: string): boolean => !!url && redactTokens(url) !== url;

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
};

const rawTokenValue = (url: string): { name: 'hdnts' | 'hdntl'; value: string } | null => {
  const q = /[?&](hdnts|hdntl)=([^&#\s]*)/i.exec(url);
  if (q) {
    return { name: q[1].toLowerCase() as 'hdnts' | 'hdntl', value: safeDecode(q[2]) };
  }
  const p = new RegExp(`/(hdnt[sl])=([^?#\\s]*?${HMAC}|[^/?#&\\s]*)`, 'i').exec(url);
  if (p) {
    return { name: p[1].toLowerCase() as 'hdnts' | 'hdntl', value: safeDecode(p[2]) };
  }
  return null;
};

/** Parse exp/st/acl from the first token in the URL. The hmac is deliberately dropped. */
export const parseToken = (url: string): TokenInfo | null => {
  if (!url) {
    return null;
  }
  const raw = rawTokenValue(url);
  if (!raw) {
    return null;
  }
  const info: TokenInfo = { name: raw.name };
  const exp = /(?:^|~)exp=(\d+)/.exec(raw.value);
  const st = /(?:^|~)st=(\d+)/.exec(raw.value);
  const acl = /(?:^|~)acl=(.*?)(?=~(?:hmac|exp|st|id|data|url|ip|hdr|salt)=|$)/.exec(raw.value);
  if (exp) {
    info.exp = Number(exp[1]);
  }
  if (st) {
    info.st = Number(st[1]);
  }
  if (acl) {
    info.acl = acl[1];
  }
  return info;
};

export const isTokenExpired = (url: string, nowMs: number): boolean => {
  const t = parseToken(url);
  return !!t && t.exp !== undefined && t.exp * 1000 <= nowMs;
};

export const describeRemaining = (exp: number, nowMs: number): { text: string; state: TokenState } => {
  const secs = Math.floor(exp - nowMs / 1000);
  if (secs <= 0) {
    return { text: 'expired', state: 'expired' };
  }
  const state: TokenState = secs < TOKEN_WARN_SECONDS ? 'warn' : 'ok';
  let text: string;
  if (secs < 60) {
    text = `${secs}s`;
  } else if (secs < 3600) {
    text = `${Math.floor(secs / 60)}m`;
  } else if (secs < 86400) {
    text = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  } else {
    text = `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
  }
  return { text: `expires in ${text}`, state };
};
