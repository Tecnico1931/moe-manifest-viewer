/** Pure logic for the Ladder check panel. No Angular imports so it can run under ts-node. */

export interface Rung {
  width: number;
  height: number;
  /** Declared BANDWIDTH, bits per second. */
  peak: number;
  /** Declared AVERAGE-BANDWIDTH, bits per second. */
  avg?: number;
  fps?: number;
}

export type RefRung = [number, number, number];

export const DEFAULT_FPS = 30;
export const MIN_STEP = 1.3;
export const MAX_STEP = 2.5;

export type CheckKind = 'duplicate-height' | 'step-small' | 'step-large' | 'top-above' | 'top-below' | 'missing-avg';

export interface Check {
  kind: CheckKind;
  label: string;
  detail: string;
}

const parseResolution = (resolution?: string): { width: number; height: number } | undefined => {
  const m = /^(\d+)x(\d+)$/i.exec((resolution || '').trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
};

/** Builds rungs from declared level data, sorted by peak. Rungs without a resolution or bandwidth are dropped. */
export const rungsFromLevels = (
  levels: { bandwidth?: number; averageBandwidth?: number; resolution?: string; frameRate?: number }[]
): Rung[] =>
  levels
    .map((l) => ({ res: parseResolution(l.resolution), l }))
    .filter(({ res, l }) => !!res && !!l.bandwidth)
    .map(({ res, l }) => ({
      width: res!.width,
      height: res!.height,
      peak: l.bandwidth as number,
      avg: l.averageBandwidth || undefined,
      fps: l.frameRate || undefined,
    }))
    .sort((a, b) => a.peak - b.peak);

const attr = (line: string, name: string): string | undefined => {
  const m = new RegExp('(?:^|[:,])' + name + '=("[^"]*"|[^,]*)').exec(line);
  return m ? m[1].replace(/^"|"$/g, '') : undefined;
};

/** Parses #EXT-X-STREAM-INF entries from a master playlist (I-frame playlists are ignored). */
export const parseMasterLadder = (text: string): Rung[] =>
  rungsFromLevels(
    text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('#EXT-X-STREAM-INF:'))
      .map((line) => ({
        bandwidth: Number(attr(line, 'BANDWIDTH')) || undefined,
        averageBandwidth: Number(attr(line, 'AVERAGE-BANDWIDTH')) || undefined,
        resolution: attr(line, 'RESOLUTION'),
        frameRate: Number(attr(line, 'FRAME-RATE')) || undefined,
      }))
  );

/** Bits per pixel per frame. */
export const bitsPerPixel = (bps: number, width: number, height: number, fps: number = DEFAULT_FPS): number =>
  width > 0 && height > 0 && fps > 0 ? bps / (width * height * fps) : NaN;

/**
 * Bitrate a reference ladder uses at a given height: linear interpolation on height between its rungs.
 * Where a reference has several rungs at one height, the highest bitrate is used. null outside its height range.
 */
export const interpolateAtHeight = (ladder: RefRung[], height: number): number | null => {
  const byHeight = new Map<number, number>();
  ladder.forEach(([, h, bps]) => byHeight.set(h, Math.max(byHeight.get(h) || 0, bps)));
  const pts = Array.from(byHeight.entries()).sort((a, b) => a[0] - b[0]);
  if (!pts.length || height < pts[0][0] || height > pts[pts.length - 1][0]) {
    return null;
  }
  const hi = pts.findIndex(([h]) => h >= height);
  if (pts[hi][0] === height) {
    return pts[hi][1];
  }
  const [h0, b0] = pts[hi - 1];
  const [h1, b1] = pts[hi];
  return b0 + ((b1 - b0) * (height - h0)) / (h1 - h0);
};

/** Percent difference of `value` relative to `ref`. */
export const percentDiff = (value: number, ref: number | null): number | null => (ref ? ((value - ref) / ref) * 100 : null);

/** Ratio of each rung's peak bitrate to the previous (lower) rung's. Index 0 is null. Rungs must be sorted by peak. */
export const stepRatios = (rungs: Rung[]): (number | null)[] =>
  rungs.map((r, i) => (i === 0 || !rungs[i - 1].peak ? null : r.peak / rungs[i - 1].peak));

const kbps = (bps: number) => Math.round(bps / 1000);

export const runChecks = (rungs: Rung[], references: { name: string; ladder: RefRung[] }[]): Check[] => {
  const checks: Check[] = [];

  const byHeight = new Map<number, Rung[]>();
  rungs.forEach((r) => byHeight.set(r.height, [...(byHeight.get(r.height) || []), r]));
  byHeight.forEach((group, height) => {
    if (group.length > 1) {
      checks.push({
        kind: 'duplicate-height',
        label: `${height}p x${group.length}`,
        detail: `${group.length} rungs at ${height}p: ${group.map((r) => kbps(r.peak) + ' kbps').join(', ')}`,
      });
    }
  });

  const ratios = stepRatios(rungs);
  ratios.forEach((ratio, i) => {
    if (ratio === null) {
      return;
    }
    const pair = `${kbps(rungs[i - 1].peak)} to ${kbps(rungs[i].peak)} kbps (${rungs[i].height}p)`;
    if (ratio < MIN_STEP) {
      checks.push({ kind: 'step-small', label: `step ${ratio.toFixed(2)}x`, detail: `Step below ${MIN_STEP}x: ${pair}` });
    } else if (ratio > MAX_STEP) {
      checks.push({ kind: 'step-large', label: `step ${ratio.toFixed(2)}x`, detail: `Step above ${MAX_STEP}x: ${pair}` });
    }
  });

  const top = rungs[rungs.length - 1];
  if (top) {
    const refBitrates = references
      .map((ref) => ({ name: ref.name, bps: interpolateAtHeight(ref.ladder, top.height) }))
      .filter((r) => r.bps !== null);
    if (refBitrates.length && refBitrates.every((r) => top.peak > (r.bps as number))) {
      checks.push({
        kind: 'top-above',
        label: `top ${top.height}p above all refs`,
        detail: `Top rung ${kbps(top.peak)} kbps exceeds every selected reference at ${top.height}p`,
      });
    } else if (refBitrates.length && refBitrates.every((r) => top.peak < (r.bps as number))) {
      checks.push({
        kind: 'top-below',
        label: `top ${top.height}p below all refs`,
        detail: `Top rung ${kbps(top.peak)} kbps is below every selected reference at ${top.height}p`,
      });
    }
  }

  const missing = rungs.filter((r) => !r.avg);
  if (missing.length) {
    checks.push({
      kind: 'missing-avg',
      label: `no AVERAGE-BANDWIDTH x${missing.length}`,
      detail: `Missing AVERAGE-BANDWIDTH on: ${missing.map((r) => `${r.height}p ${kbps(r.peak)} kbps`).join(', ')}`,
    });
  }
  return checks;
};

/** Axis ticks (bps) for a log scale: 1-2-5 sequence within [min, max], extended to cover the range. */
export const logTicks = (min: number, max: number): number[] => {
  const ticks: number[] = [];
  for (let p = Math.pow(10, Math.floor(Math.log10(min))); p <= max * 10; p *= 10) {
    [1, 2, 5].forEach((m) => ticks.push(m * p));
  }
  const lo = ticks.filter((t) => t <= min).pop() || ticks[0];
  const hi = ticks.find((t) => t >= max) || ticks[ticks.length - 1];
  return ticks.filter((t) => t >= lo && t <= hi);
};

export const formatKbps = (bps: number): string => {
  const k = bps / 1000;
  return k >= 1000 ? `${+(k / 1000).toFixed(1)}M` : `${Math.round(k)}k`;
};
