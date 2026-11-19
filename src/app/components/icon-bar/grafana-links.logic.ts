/**
 * Builds "Open in Grafana" link-outs for Peloton Akamai (AMD) manifests.
 * Dashboards live in the Peloton Hydrolix/TrafficPeak Grafana (CMCD streaming
 * set). Pure functions only; query strings / tokens are never copied into links.
 */
export const GRAFANA_BASE_URL = 'https://peloton-grafana.trafficpeak.live';
export const GRAFANA_DATASOURCE_UID = 'cffmbn4dg0lc0d';
export const GRAFANA_DATASOURCE_TYPE = 'grafana-clickhouse-datasource';
export const GRAFANA_TABLE = 'akamai.logs';
export const PELOTON_AKAMAI_HOSTS = ['amd-vod.akamaized.net', 'qa1-amd.akamaized.net'];

/** Dashboards that expose pathLike / classID / reqHost variables. */
export const GRAFANA_DASHBOARDS = [
  { label: 'Class Analysis', uid: 'cmcd_by_class' },
  { label: 'Performance Overview', uid: 'cmcd_perf_overview' },
  { label: 'Debug & Details', uid: 'cmcd_debug_details' },
];

export interface GrafanaLink {
  label: string;
  url: string;
}

export interface ParsedManifestUrl {
  host: string;
  path: string;
}

export function parseManifestUrl(manifestUrl: string): ParsedManifestUrl | null {
  const match = /^https?:\/\/([^\/?#:]+)(?::\d+)?(\/[^?#]*)?/i.exec((manifestUrl || '').trim());
  if (!match) {
    return null;
  }
  return { host: match[1].toLowerCase(), path: match[2] || '/' };
}

export function isPelotonAkamaiUrl(manifestUrl: string): boolean {
  const parsed = parseManifestUrl(manifestUrl);
  return !!parsed && PELOTON_AKAMAI_HOSTS.indexOf(parsed.host) !== -1;
}

/** Only characters that are safe inside a SQL LIKE literal and a URL path. */
const SAFE_ASSET = /^[A-Za-z0-9_.\-\/]+$/;

/**
 * classes/{sport}/{date}/{classID}/... -> classID (same regex the dashboards use).
 * Otherwise falls back to the manifest's directory path (filename removed).
 */
export function extractAssetId(manifestUrl: string): { id: string; isClassId: boolean } | null {
  const parsed = parseManifestUrl(manifestUrl);
  if (!parsed) {
    return null;
  }
  const classMatch = /classes\/[^\/]+\/[^\/]+\/([^\/]+)/.exec(parsed.path);
  if (classMatch && SAFE_ASSET.test(classMatch[1])) {
    return { id: classMatch[1], isClassId: true };
  }
  const dir = parsed.path.replace(/\/[^\/]*$/, '').replace(/^\/+/, '');
  if (dir && SAFE_ASSET.test(dir)) {
    return { id: dir, isClassId: false };
  }
  return null;
}

function query(params: Array<[string, string]>): string {
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export function buildExploreSql(assetId: string): string {
  return (
    `SELECT reqTimeSec, reqHost, reqPath, statusCode, cacheStatus, hdx_source_latency\n` +
    `FROM ${GRAFANA_TABLE}\n` +
    `WHERE reqTimeSec >= now() - INTERVAL 6 HOUR\n` +
    `  AND reqPath LIKE '%${assetId}%'\n` +
    `ORDER BY reqTimeSec DESC\nLIMIT 200`
  );
}

export function buildExploreUrl(assetId: string, baseUrl: string = GRAFANA_BASE_URL): string {
  const left = {
    datasource: GRAFANA_DATASOURCE_UID,
    queries: [
      {
        refId: 'A',
        datasource: { type: GRAFANA_DATASOURCE_TYPE, uid: GRAFANA_DATASOURCE_UID },
        editorType: 'sql',
        format: 1,
        rawSql: buildExploreSql(assetId),
      },
    ],
    range: { from: 'now-6h', to: 'now' },
  };
  return `${baseUrl}/explore?${query([['orgId', '1'], ['left', JSON.stringify(left)]])}`;
}

export function buildDashboardUrl(uid: string, host: string, assetId: string | null, baseUrl: string = GRAFANA_BASE_URL): string {
  const params: Array<[string, string]> = [['orgId', '1'], ['from', 'now-24h'], ['to', 'now'], ['var-reqHost', host]];
  if (assetId) {
    // classID is a query variable (top 50); pathLike is a free-text LIKE filter, so it works for any asset.
    params.push(['var-pathLike', `%${assetId}%`]);
  }
  return `${baseUrl}/d/${uid}?${query(params)}`;
}

/** Returns [] for non Peloton-Akamai URLs. */
export function grafanaLinks(manifestUrl: string, baseUrl: string = GRAFANA_BASE_URL): GrafanaLink[] {
  const parsed = parseManifestUrl(manifestUrl);
  if (!parsed || PELOTON_AKAMAI_HOSTS.indexOf(parsed.host) === -1) {
    return [];
  }
  const host = parsed.host;
  const asset = extractAssetId(manifestUrl);
  const assetId = asset ? asset.id : null;
  const links = GRAFANA_DASHBOARDS.map((d) => ({ label: d.label, url: buildDashboardUrl(d.uid, host, assetId, baseUrl) }));
  if (assetId) {
    links.push({ label: 'Explore (Hydrolix)', url: buildExploreUrl(assetId, baseUrl) });
  }
  return links;
}

export const GRAFANA_TOOLTIP =
  'Open CMCD/Akamai dashboards in Grafana, filtered by this host and asset path (pathLike variable), last 24h.';
