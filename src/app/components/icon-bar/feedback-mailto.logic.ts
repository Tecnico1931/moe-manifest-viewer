export const FEEDBACK_EMAIL = 'raul@onepeloton.com';
export const FEEDBACK_SUBJECT = 'MOE Viewer feedback';

/** Drops the query string and fragment so tokens never leave the app. */
export function stripQuery(url: string): string {
  return (url || '').split('#')[0].split('?')[0];
}

export function buildFeedbackMailto(version: string, manifestUrl: string): string {
  const body = ['', '', '---', `MOE Viewer (Peloton build) ${version || '—'}`, `Manifest: ${stripQuery(manifestUrl) || '—'}`].join('\n');
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(FEEDBACK_SUBJECT)}&body=${encodeURIComponent(body)}`;
}
