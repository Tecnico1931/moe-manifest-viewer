import { PRAGMA_VALUE } from './edge-view.logic';

/** Opt-in: ask Akamai for its debug headers by sending Pragma on HLS.js requests. Off by default, because
 * Pragma is not a CORS-safelisted header: unless the CDN allows it in Access-Control-Allow-Headers, the
 * preflight fails and every request is blocked. Read when the player is created, so it applies on the next load. */
const KEY = 'MV_AKAMAI_PRAGMA';

export const isAkamaiPragmaEnabled = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export const setAkamaiPragmaEnabled = (on: boolean): void => {
  try {
    if (on) {
      localStorage.setItem(KEY, '1');
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    /* storage unavailable: leave it off */
  }
};

export const addAkamaiPragma = (xhr: XMLHttpRequest): void => {
  if (isAkamaiPragmaEnabled()) {
    xhr.setRequestHeader('Pragma', PRAGMA_VALUE);
  }
};
