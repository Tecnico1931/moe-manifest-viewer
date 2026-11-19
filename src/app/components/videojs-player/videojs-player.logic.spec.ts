import * as assert from 'assert';
import { sourceTypeFor, requestKindFor, uniqueBitrates, levelsToEnable } from './videojs-player.logic';

const B = 'https://amd-vod.akamaized.net/classes/a/1';

// source type
assert.strictEqual(sourceTypeFor(`${B}/master.m3u8?hdnts=x`), 'application/x-mpegURL');
assert.strictEqual(sourceTypeFor(`${B}/manifest.mpd`), 'application/dash+xml');
assert.strictEqual(sourceTypeFor(`${B}/manifest.MPD?x=1#t`), 'application/dash+xml');
assert.strictEqual(sourceTypeFor(`${B}/stream`), 'application/x-mpegURL');

// request kinds: first playlist is the master, later ones are media playlists
assert.strictEqual(requestKindFor(`${B}/master.m3u8`, true), 'master');
assert.strictEqual(requestKindFor(`${B}/manifest.mpd`, true), 'master');
assert.strictEqual(requestKindFor(`${B}/1080p/index.m3u8`, false), 'variant');
assert.strictEqual(requestKindFor(`${B}/audio_en_256k/index.m3u8`, false), 'audio-playlist');
assert.strictEqual(requestKindFor(`${B}/subtitles_en/index.m3u8`, false), 'subtitle-playlist');
assert.strictEqual(requestKindFor(`${B}/1080p/seg_00012.ts?hdntl=x`, false), 'video-segment');
assert.strictEqual(requestKindFor(`${B}/1080p/seg_00012.m4s`, false), 'video-segment');
assert.strictEqual(requestKindFor(`${B}/audio_en_256k/seg_00012.aac`, false), 'audio-segment');
assert.strictEqual(requestKindFor(`${B}/audio/seg_1.m4s`, false), 'audio-segment');
assert.strictEqual(requestKindFor(`${B}/1080p/init.mp4`, false), 'init');
assert.strictEqual(requestKindFor(`${B}/subtitles_en/seg_1.vtt`, false), 'subtitle-segment');
assert.strictEqual(requestKindFor(`${B}/key.bin`, false), 'other');
// "audio" in the host or class id must not make a video segment look like audio
assert.strictEqual(requestKindFor('https://audio-host.example.com/v/1080p/seg_1.ts', false), 'video-segment');

// bitrates: unique, ascending, positive only
assert.deepStrictEqual(uniqueBitrates([{ bitrate: 4800000 }, { bitrate: 800000 }, { bitrate: 4800000 }, { bitrate: 0 }]), [800000, 4800000]);
assert.deepStrictEqual(uniqueBitrates([]), []);

// quality selection: null = auto (all on); a bitrate keeps only matching levels
const lv = [{ bitrate: 800000 }, { bitrate: 2400000 }, { bitrate: 4800000 }];
assert.deepStrictEqual(levelsToEnable(lv, null), [true, true, true]);
assert.deepStrictEqual(levelsToEnable(lv, 2400000), [false, true, false]);
// unknown bitrate: leave everything on rather than disabling every level
assert.deepStrictEqual(levelsToEnable(lv, 123), [true, true, true]);

console.log('videojs-player.logic: all checks passed');
