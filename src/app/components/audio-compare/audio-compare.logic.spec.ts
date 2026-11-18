import * as assert from 'assert';
import {
  extractAdtsFromTs,
  integratedLoudness,
  kWeightingFilters,
  lufsSpread,
  measuredKbpsByTrack,
  measureTrack,
  parseMasterAudio,
  parseMediaPlaylist,
  pickSegmentIndex,
  samplePeakDb,
  truePeakDb,
} from './audio-compare.logic';

const FS = 48000;
const sine = (freq: number, dbfs: number, seconds: number, fs = FS, phase = 0): Float32Array => {
  const amp = Math.pow(10, dbfs / 20);
  return Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => amp * Math.sin(2 * Math.PI * freq * (i / fs) + phase));
};
const near = (actual: number, expected: number, tol: string | number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= Number(tol), `${label}: ${actual} not within ${tol} of ${expected}`);

// K-weighting coefficients at 48 kHz match the published BS.1770 table
const [shelf, hp] = kWeightingFilters(48000);
near(shelf.b[0], 1.53512485958697, 1e-9, 'shelf b0');
near(shelf.b[1], -2.69169618940638, 1e-9, 'shelf b1');
near(shelf.b[2], 1.19839281085285, 1e-9, 'shelf b2');
near(shelf.a[0], -1.69065929318241, 1e-9, 'shelf a1');
near(shelf.a[1], 0.73248077421585, 1e-9, 'shelf a2');
near(hp.a[0], -1.99004745483398, 1e-9, 'hp a1');
near(hp.a[1], 0.99007225036621, 1e-9, 'hp a2');

// BS.1770 calibration: a full-scale 997 Hz sine reads -3.01 LKFS mono, so a -20 dBFS (peak) sine reads -23.0 mono
// and -20.0 when the same signal is on both stereo channels (the usual "-20 dBFS reads -20 LKFS" reference).
near(integratedLoudness([sine(997, -20, 5)], 48000).lufs, -23.01, 0.3, '997Hz -20dBFS mono @48k');
near(integratedLoudness([sine(997, -20, 5, 44100)], 44100).lufs, -23.01, 0.3, '997Hz -20dBFS mono @44.1k');
near(integratedLoudness([sine(997, -20, 5), sine(997, -20, 5)], 48000).lufs, -20, 0.3, '997Hz -20dBFS stereo');
// A mono sine whose RMS (not peak) is -20 dBFS reads -20 LKFS
near(integratedLoudness([sine(997, -20 + 3.0103, 5)], 48000).lufs, -20, 0.3, '997Hz -20 dBFS RMS mono');

// Sample peak and true peak
near(samplePeakDb([sine(997, -6, 1, FS, Math.PI / 2)]), -6, 0.01, 'sample peak -6');
// 11.025 kHz at 44.1k sampled 45 degrees off the crest: sample peak is ~3 dB under the true peak
const inter = sine(11025, 0, 0.2, 44100, Math.PI / 4);
const spk = samplePeakDb([inter]);
const tpk = truePeakDb([inter]);
assert.ok(spk < -2.5 && spk > -3.5, `inter sample peak ${spk}`);
near(tpk, 0, 0.5, 'inter true peak');
assert.ok(tpk >= spk, 'true peak >= sample peak');

// Silence
assert.strictEqual(integratedLoudness([new Float32Array(FS * 2)], FS).lufs, -Infinity);
assert.strictEqual(samplePeakDb([new Float32Array(100)]), -Infinity);

// Gating removes a silent half
const half = sine(997, -20, 3);
const gated = integratedLoudness([Float32Array.from([...half, ...new Float32Array(3 * FS)])], FS);
near(gated.lufs, -23.01, 0.5, 'gated half-silent');
assert.ok(gated.gatedBlocks < gated.blocks, 'some blocks gated out');
// A quiet half (-40 dB below) is removed by the relative gate
const quiet = Float32Array.from([...sine(997, -20, 3), ...sine(997, -45, 3)]);
near(integratedLoudness([quiet], FS).lufs, -23.01, 0.5, 'relative gate');

// measureTrack
const m = measureTrack([sine(997, -20, 2)], FS);
near(m.durationSec, 2, 0.001, 'duration');
assert.strictEqual(m.channels, 1);

// Spread
assert.deepStrictEqual(lufsSpread([-20]), undefined);
assert.strictEqual(lufsSpread([-20, -25.1, -Infinity])!.isWarm, true);
assert.strictEqual(lufsSpread([-20, -21.5])!.isWarm, false);

// Playlists
const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Mixed",LANGUAGE="en",DEFAULT=YES,CHANNELS="2",URI="a/mixed.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Music, only",DEFAULT=NO,URI="https://x.test/m.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="s.m3u8"`;
const renditions = parseMasterAudio(master, 'https://cdn.test/p/master.m3u8');
assert.strictEqual(renditions.length, 2);
assert.strictEqual(renditions[0].uri, 'https://cdn.test/p/a/mixed.m3u8');
assert.strictEqual(renditions[0].isDefault, true);
assert.strictEqual(renditions[1].name, 'Music, only');
const media = parseMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\ns0.m4s\n#EXTINF:4.0,\ns1.m4s\n#EXTINF:6,\ns2.m4s', 'https://cdn.test/p/a/mixed.m3u8');
assert.strictEqual(media.segments.length, 3);
assert.strictEqual(media.mapUrl, 'https://cdn.test/p/a/init.mp4');
assert.strictEqual(media.segments[1].url, 'https://cdn.test/p/a/s1.m4s');
const ranged = parseMediaPlaylist('#EXTINF:2,\n#EXT-X-BYTERANGE:100@0\nf.aac\n#EXTINF:2,\n#EXT-X-BYTERANGE:50\nf.aac', 'https://a.test/x.m3u8');
assert.deepStrictEqual(ranged.segments[1].byteRange, { length: 50, offset: 100 });
assert.strictEqual(pickSegmentIndex(media.segments, 7), 1);
assert.strictEqual(pickSegmentIndex(media.segments, undefined), 2);
assert.strictEqual(pickSegmentIndex(media.segments.slice(0, 2), 0), 1);
assert.strictEqual(pickSegmentIndex(media.segments, 999), 2);

// Measured kbps
const kb = measuredKbpsByTrack([
  { trackName: 'Mixed', bytes: 96000, durationSec: 6 },
  { trackName: 'Mixed', bytes: 96000, durationSec: 6 },
  { trackName: 'Music', bytes: 48000, durationSec: 6 },
  { bytes: 1, durationSec: 1 },
]);
near(kb.Mixed.kbps, 128, 0.001, 'kbps mixed');
near(kb.Music.kbps, 64, 0.001, 'kbps music');

// TS audio extraction: one PES packet (stream 0xC0) with a continuation, plus a private stream (0xBD) that is ignored
const tsPacket = (pid: number, pusi: boolean, payload: number[]): number[] => {
  const header = [0x47, (pusi ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10];
  const stuffing = 188 - 4 - payload.length;
  assert.ok(stuffing >= 0);
  // adaptation-field stuffing keeps payload at the end of the packet
  return stuffing === 0
    ? [...header, ...payload]
    : [
        0x47,
        (pusi ? 0x40 : 0) | (pid >> 8),
        pid & 0xff,
        0x30,
        stuffing - 1,
        ...(stuffing > 1 ? [0, ...new Array(stuffing - 2).fill(0xff)] : []),
        ...payload,
      ];
};
const pes = (id: number, data: number[]) => [0, 0, 1, id, 0, 0, 0x80, 0, 0, ...data];
const ts = Uint8Array.from([
  ...tsPacket(0x101, true, pes(0xc0, [0xff, 0xf1, 1, 2])),
  ...tsPacket(0x102, true, pes(0xbd, [9, 9, 9])),
  ...tsPacket(0x101, false, [3, 4]),
]);
assert.deepStrictEqual(Array.from(extractAdtsFromTs(ts)!), [0xff, 0xf1, 1, 2, 3, 4]);
assert.strictEqual(extractAdtsFromTs(Uint8Array.from(tsPacket(0x102, true, pes(0xbd, [1])))), undefined);

console.log('audio-compare.logic: all assertions passed');
