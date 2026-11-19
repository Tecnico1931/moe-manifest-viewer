/** Token redaction for the session report. Pure, no imports. Removes Akamai auth tokens and the CMCD session id. */

const TOKEN_MARK = '[token]';
const SECRET_PARAMS = ['hdnts', 'hdntl', 'hdnea', 'hmac', 'token', 'access_token', 'signature', 'sid'];
const TOKEN_SEGMENT_START = /^(hdntl|hdnts|hdnea)=/i;

/** Token path segments: hdntl=exp=..~acl=/a/b/*~hmac=.. can span several "/" parts, up to the one holding hmac=. */
const redactPath = (path: string): string => {
  const out: string[] = [];
  let isSwallowing = false;
  path.split('/').forEach((seg) => {
    if (isSwallowing) {
      isSwallowing = !/hmac=/i.test(seg);
      return;
    }
    if (TOKEN_SEGMENT_START.test(seg) || /hmac=/i.test(seg)) {
      isSwallowing = !/hmac=/i.test(seg);
      out.push('{token}');
      return;
    }
    out.push(seg);
  });
  return out.join('/');
};

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
};

const redactQueryParam = (param: string): string | null => {
  const eq = param.indexOf('=');
  const name = safeDecode(eq < 0 ? param : param.slice(0, eq)).toLowerCase();
  if (SECRET_PARAMS.indexOf(name) >= 0) {
    return null;
  }
  if (name === 'cmcd' && eq >= 0) {
    const cleaned = safeDecode(param.slice(eq + 1))
      .split(',')
      .filter((kv) => !/^sid=/i.test(kv.trim()))
      .join(',');
    return cleaned ? 'CMCD=' + encodeURIComponent(cleaned) : null;
  }
  return param;
};

/** Free text (log lines, error messages): replaces token fragments and CMCD sid values wherever they appear. */
export const redactText = (text: string): string =>
  String(text === undefined || text === null ? '' : text)
    .replace(/(hdnts|hdntl|hdnea)=(?:(?!hmac=)[^\s"'<>&])*hmac=[0-9a-f]*/gi, TOKEN_MARK)
    .replace(/(hdnts|hdntl|hdnea)=[^\s"'<>&]*/gi, TOKEN_MARK)
    .replace(/hmac=[0-9a-f]*/gi, TOKEN_MARK)
    .replace(/\bsid(?:=|%3D)(?:%22|")?[^\s"'&,%]*(?:%22|")?/gi, 'sid=[redacted]')
    .replace(/hdnt[sl]|hdnea|hmac/gi, TOKEN_MARK);

/** A URL with token query params, token path segments, the CMCD sid and the fragment removed. */
export const redact = (url: string): string => {
  if (!url) {
    return '';
  }
  const noFragment = url.split('#')[0];
  const qIndex = noFragment.indexOf('?');
  const base = qIndex < 0 ? noFragment : noFragment.slice(0, qIndex);
  const query = qIndex < 0 ? '' : noFragment.slice(qIndex + 1);
  const m = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*)(\/.*)?$/i.exec(base);
  const cleanBase = m ? m[1] + redactPath(m[2] || '') : redactPath(base);
  const params = query
    .split('&')
    .filter((p) => !!p)
    .map(redactQueryParam)
    .filter((p): p is string => p !== null);
  return redactText(cleanBase + (params.length ? '?' + params.join('&') : ''));
};

/** Applies redactText to every string in a JSON-like value (final safety net before a report leaves the page). */
export const redactDeep = <T>(value: T): T => {
  if (typeof value === 'string') {
    return redactText(value) as any;
  }
  if (Array.isArray(value)) {
    return value.map(redactDeep) as any;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((acc, k) => ({ ...acc, [k]: redactDeep((value as any)[k]) }), {}) as any;
  }
  return value;
};
