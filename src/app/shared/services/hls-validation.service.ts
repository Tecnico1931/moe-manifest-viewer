import { Injectable } from '@angular/core';
import {
  HlsIssue,
  HlsValidationResult,
  HlsIssueSeverity,
  HlsIssueCategory,
  HLS_ISSUE_CODES,
} from '../models/hls-issue.model';

interface ParsedTag {
  line: string;
  lineNumber: number;
  tag?: string;
  value?: string;
  attributes?: Record<string, string>;
}

@Injectable()
export class HlsValidationService {
  private readonly TAG_REGEX = /^#(EXT[A-Z0-9-]*):?(.*)$/;
  private readonly ATTR_REGEX = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  private readonly EXTINF_REGEX = /^(\d+(?:\.\d+)?)/;
  private readonly VERSION_REGEX = /#EXT-X-VERSION:(\d+)/;
  private readonly TARGET_DURATION_REGEX = /#EXT-X-TARGETDURATION:(\d+)/;
  private readonly MEDIA_SEQUENCE_REGEX = /#EXT-X-MEDIA-SEQUENCE:(\d+)/;
  private readonly BANDWIDTH_REGEX = /BANDWIDTH=(\d+)/;

  constructor() {}

  /**
   * Validate an HLS manifest against the RFC 8216bis specification
   */
  public validateManifest(manifest: string, isMediaPlaylist: boolean = false): HlsValidationResult {
    const issues: HlsIssue[] = [];
    const lines = manifest.split('\n').map((line) => line.trim());

    // Detect manifest type if not specified
    const detectedIsMedia = this.isMediaPlaylist(manifest);
    const isMedia = isMediaPlaylist || detectedIsMedia;

    // Structure validation
    this.validateStructure(lines, issues);

    // Get version for compatibility checks
    const version = this.getVersion(manifest);

    // Parse all tags
    const parsedTags = this.parseAllTags(lines);

    if (isMedia) {
      this.validateMediaPlaylist(manifest, lines, parsedTags, version, issues);
    } else {
      this.validateMasterPlaylist(manifest, lines, parsedTags, version, issues);
    }

    // Best practices
    this.validateBestPractices(manifest, lines, isMedia, issues);

    return this.buildResult(issues);
  }

  /**
   * Validate manifest from player errors
   */
  public validateFromPlayerError(errorType: string, errorDetails: string, manifest?: string): HlsIssue[] {
    const issues: HlsIssue[] = [];

    // Map common hls.js errors to spec issues
    if (errorType === 'networkError') {
      issues.push(
        this.createIssue(
          'P003',
          'error',
          'media-playlist',
          'Segment failed to load',
          `Network error loading segment: ${errorDetails}`,
          undefined,
          'RFC 8216 Section 6.2.2'
        )
      );
    } else if (errorType === 'mediaError') {
      issues.push(
        this.createIssue(
          'S004',
          'error',
          'structure',
          'Media decode error',
          `Player could not decode media: ${errorDetails}`,
          undefined,
          'RFC 8216 Section 3'
        )
      );
    } else if (errorDetails?.includes('manifestLoadError')) {
      issues.push(
        this.createIssue(
          'S003',
          'error',
          'structure',
          'Manifest load failed',
          'Could not load or parse manifest',
          undefined,
          'RFC 8216 Section 4'
        )
      );
    }

    // If manifest is available, run full validation
    if (manifest) {
      const result = this.validateManifest(manifest);
      issues.push(...result.issues);
    }

    return issues;
  }

  private isMediaPlaylist(manifest: string): boolean {
    return manifest.includes('#EXTINF:') || manifest.includes('#EXT-X-TARGETDURATION:');
  }

  private getVersion(manifest: string): number {
    const match = this.VERSION_REGEX.exec(manifest);
    return match ? parseInt(match[1], 10) : 1;
  }

  private parseAllTags(lines: string[]): ParsedTag[] {
    return lines.map((line, index) => {
      const parsed: ParsedTag = { line, lineNumber: index + 1 };
      const tagMatch = this.TAG_REGEX.exec(line);
      if (tagMatch) {
        parsed.tag = tagMatch[1];
        parsed.value = tagMatch[2];
        parsed.attributes = this.parseAttributes(tagMatch[2]);
      }
      return parsed;
    });
  }

  private parseAttributes(value: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    let match;
    const regex = new RegExp(this.ATTR_REGEX.source, 'g');
    while ((match = regex.exec(value)) !== null) {
      attrs[match[1]] = match[2] || match[3];
    }
    return attrs;
  }

  /**
   * Validate basic manifest structure
   */
  private validateStructure(lines: string[], issues: HlsIssue[]): void {
    // Check for empty manifest
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      issues.push(
        this.createIssue(HLS_ISSUE_CODES.EMPTY_MANIFEST, 'error', 'structure', 'Manifest is empty', 'HLS manifests must contain at least #EXTM3U', 1, 'RFC 8216 Section 4.1')
      );
      return;
    }

    // Check for #EXTM3U
    const hasExtM3U = lines.some((line) => line === '#EXTM3U');
    if (!hasExtM3U) {
      issues.push(
        this.createIssue(
          HLS_ISSUE_CODES.MISSING_EXTM3U,
          'error',
          'structure',
          'Missing #EXTM3U tag',
          'Every HLS playlist MUST start with #EXTM3U',
          1,
          'RFC 8216 Section 4.3.1.1'
        )
      );
    } else if (lines[0] !== '#EXTM3U') {
      issues.push(
        this.createIssue(
          HLS_ISSUE_CODES.EXTM3U_NOT_FIRST,
          'error',
          'structure',
          '#EXTM3U is not the first line',
          'The #EXTM3U tag MUST be the first line of the playlist',
          1,
          'RFC 8216 Section 4.3.1.1'
        )
      );
    }
  }

  /**
   * Validate media playlist specific rules
   */
  private validateMediaPlaylist(
    manifest: string,
    lines: string[],
    parsedTags: ParsedTag[],
    version: number,
    issues: HlsIssue[]
  ): void {
    // Check for EXT-X-TARGETDURATION (required)
    const targetDurationMatch = this.TARGET_DURATION_REGEX.exec(manifest);
    if (!targetDurationMatch) {
      issues.push(
        this.createIssue(
          HLS_ISSUE_CODES.MISSING_TARGET_DURATION,
          'error',
          'required-tag',
          'Missing #EXT-X-TARGETDURATION',
          'Media playlists MUST contain an EXT-X-TARGETDURATION tag',
          undefined,
          'RFC 8216 Section 4.3.3.1'
        )
      );
    }

    const targetDuration = targetDurationMatch ? parseInt(targetDurationMatch[1], 10) : 0;

    // Validate EXTINF durations
    let lastExtinfLine: number | undefined;
    let segmentCount = 0;
    const durations: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXTINF:')) {
        const extinfMatch = this.EXTINF_REGEX.exec(line.substring(8));
        if (extinfMatch) {
          const duration = parseFloat(extinfMatch[1]);
          durations.push(duration);

          // Check if duration exceeds target duration (when rounded)
          if (targetDuration > 0 && Math.round(duration) > targetDuration) {
            issues.push(
              this.createIssue(
                HLS_ISSUE_CODES.EXTINF_EXCEEDS_TARGET,
                'error',
                'duration',
                `Segment duration ${duration.toFixed(3)}s exceeds target duration ${targetDuration}s`,
                'EXTINF duration (rounded) MUST be <= EXT-X-TARGETDURATION',
                i + 1,
                'RFC 8216 Section 4.3.3.1'
              )
            );
          }

          // Check for zero or negative duration
          if (duration <= 0) {
            issues.push(
              this.createIssue(
                duration === 0 ? HLS_ISSUE_CODES.ZERO_DURATION_SEGMENT : HLS_ISSUE_CODES.NEGATIVE_DURATION,
                'error',
                'duration',
                `Invalid segment duration: ${duration}`,
                'Segment duration must be positive',
                i + 1,
                'RFC 8216 Section 4.3.2.1'
              )
            );
          }

          // Check version compatibility for floating point EXTINF
          if (version < 3 && duration !== Math.floor(duration)) {
            issues.push(
              this.createIssue(
                HLS_ISSUE_CODES.FLOATING_POINT_EXTINF_V2,
                'error',
                'compatibility',
                'Floating point EXTINF requires version 3+',
                `Found floating point duration ${duration} but version is ${version}`,
                i + 1,
                'RFC 8216 Section 4.3.2.1'
              )
            );
          }

          lastExtinfLine = i;
        }
      } else if (lastExtinfLine !== undefined && !line.startsWith('#') && line.length > 0) {
        // This is a segment URI following EXTINF
        segmentCount++;
        lastExtinfLine = undefined;
      }
    }

    // Check if EXTINF is followed by segment URI
    if (lastExtinfLine !== undefined) {
      issues.push(
        this.createIssue(
          HLS_ISSUE_CODES.MISSING_SEGMENT_AFTER_EXTINF,
          'error',
          'media-playlist',
          'EXTINF not followed by segment URI',
          'Each EXTINF tag MUST be followed by a Media Segment URI',
          lastExtinfLine + 1,
          'RFC 8216 Section 4.3.2.1'
        )
      );
    }

    // Check for live stream requirements
    const isLive = !manifest.includes('#EXT-X-ENDLIST');
    if (isLive) {
      // Live streams should have EXT-X-MEDIA-SEQUENCE
      if (!manifest.includes('#EXT-X-MEDIA-SEQUENCE')) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.MISSING_MEDIA_SEQUENCE_LIVE,
            'warning',
            'media-playlist',
            'Live stream missing #EXT-X-MEDIA-SEQUENCE',
            'Live playlists should include EXT-X-MEDIA-SEQUENCE for proper segment tracking',
            undefined,
            'RFC 8216 Section 4.3.3.2'
          )
        );
      }

      // Apple recommends at least 6 segments for live
      if (segmentCount < 6 && segmentCount > 0) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.TOO_FEW_SEGMENTS_LIVE,
            'warning',
            'best-practice',
            `Live stream has only ${segmentCount} segments`,
            'Apple HLS Authoring Spec recommends at least 6 segments for live streams',
            undefined,
            'Apple HLS Authoring Specification'
          )
        );
      }
    }

    // Check for VOD requirements
    if (!isLive && !manifest.includes('#EXT-X-ENDLIST')) {
      // This case won't happen as isLive is determined by ENDLIST
    }

    // Check discontinuity handling
    const hasDiscontinuity = manifest.includes('#EXT-X-DISCONTINUITY');
    const hasDiscontinuitySequence = manifest.includes('#EXT-X-DISCONTINUITY-SEQUENCE');
    if (hasDiscontinuity && isLive && !hasDiscontinuitySequence) {
      issues.push(
        this.createIssue(
          HLS_ISSUE_CODES.DISCONTINUITY_WITHOUT_SEQUENCE,
          'warning',
          'media-playlist',
          'Discontinuity without sequence tag',
          'Live playlists with discontinuities should include EXT-X-DISCONTINUITY-SEQUENCE',
          undefined,
          'RFC 8216 Section 4.3.3.3'
        )
      );
    }
  }

  /**
   * Validate master playlist specific rules
   */
  private validateMasterPlaylist(
    manifest: string,
    lines: string[],
    parsedTags: ParsedTag[],
    version: number,
    issues: HlsIssue[]
  ): void {
    const streamInfTags = parsedTags.filter((t) => t.tag === 'EXT-X-STREAM-INF');
    const bandwidths: number[] = [];

    if (streamInfTags.length === 0) {
      // Check if it might actually be a media playlist misidentified
      if (!manifest.includes('#EXT-X-MEDIA:')) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.NO_VARIANTS,
            'warning',
            'master-playlist',
            'Master playlist has no variant streams',
            'Master playlists should contain at least one EXT-X-STREAM-INF',
            undefined,
            'RFC 8216 Section 4.3.4.2'
          )
        );
      }
    }

    for (const tag of streamInfTags) {
      const attrs = tag.attributes || {};

      // BANDWIDTH is required
      if (!attrs.BANDWIDTH) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.MISSING_BANDWIDTH,
            'error',
            'master-playlist',
            'EXT-X-STREAM-INF missing required BANDWIDTH attribute',
            'The BANDWIDTH attribute is REQUIRED',
            tag.lineNumber,
            'RFC 8216 Section 4.3.4.2'
          )
        );
      } else {
        const bandwidth = parseInt(attrs.BANDWIDTH, 10);
        if (bandwidths.includes(bandwidth)) {
          issues.push(
            this.createIssue(
              HLS_ISSUE_CODES.DUPLICATE_BANDWIDTH,
              'warning',
              'master-playlist',
              `Duplicate BANDWIDTH value: ${bandwidth}`,
              'Each variant should have a unique BANDWIDTH',
              tag.lineNumber,
              'RFC 8216 Section 4.3.4.2'
            )
          );
        }
        bandwidths.push(bandwidth);
      }

      // CODECS is recommended
      if (!attrs.CODECS) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.MISSING_CODECS,
            'warning',
            'master-playlist',
            'EXT-X-STREAM-INF missing CODECS attribute',
            'CODECS should be included for proper client compatibility',
            tag.lineNumber,
            'Apple HLS Authoring Specification'
          )
        );
      }

      // RESOLUTION is recommended for video
      if (!attrs.RESOLUTION && attrs.CODECS && !attrs.CODECS.includes('mp4a.')) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.MISSING_RESOLUTION,
            'warning',
            'master-playlist',
            'EXT-X-STREAM-INF missing RESOLUTION attribute',
            'RESOLUTION should be included for video variants',
            tag.lineNumber,
            'Apple HLS Authoring Specification'
          )
        );
      }

      // Check that stream-inf is followed by URI
      const nextLineIndex = tag.lineNumber; // 0-indexed would be lineNumber - 1 + 1
      if (nextLineIndex < lines.length) {
        const nextLine = lines[nextLineIndex];
        if (!nextLine || nextLine.startsWith('#') || nextLine.trim() === '') {
          issues.push(
            this.createIssue(
              HLS_ISSUE_CODES.SEGMENT_URL_INVALID,
              'error',
              'master-playlist',
              'EXT-X-STREAM-INF not followed by URI',
              'Each EXT-X-STREAM-INF tag MUST be followed by a URI',
              tag.lineNumber,
              'RFC 8216 Section 4.3.4.2'
            )
          );
        }
      }
    }
  }

  /**
   * Validate best practices
   */
  private validateBestPractices(manifest: string, lines: string[], isMedia: boolean, issues: HlsIssue[]): void {
    // Check for EXT-X-INDEPENDENT-SEGMENTS
    if (!manifest.includes('#EXT-X-INDEPENDENT-SEGMENTS')) {
      issues.push(
        this.createIssue(
          HLS_ISSUE_CODES.MISSING_INDEPENDENT_SEGMENTS,
          'info',
          'best-practice',
          'Consider adding #EXT-X-INDEPENDENT-SEGMENTS',
          'This tag indicates segments can be decoded independently, improving seeking',
          undefined,
          'RFC 8216 Section 4.3.5.1'
        )
      );
    }

    // Check for version tag
    if (!manifest.includes('#EXT-X-VERSION')) {
      issues.push(
        this.createIssue(
          HLS_ISSUE_CODES.MISSING_VERSION,
          'info',
          'required-tag',
          'Missing #EXT-X-VERSION tag',
          'Including EXT-X-VERSION helps clients handle compatibility',
          undefined,
          'RFC 8216 Section 4.3.1.2'
        )
      );
    }

    // Check target duration is reasonable
    const targetMatch = this.TARGET_DURATION_REGEX.exec(manifest);
    if (targetMatch) {
      const target = parseInt(targetMatch[1], 10);
      if (target > 10) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.HIGH_TARGET_DURATION,
            'info',
            'best-practice',
            `Target duration ${target}s is high`,
            'Lower target durations (2-6s) provide better latency and adaptability',
            undefined,
            'Apple HLS Authoring Specification'
          )
        );
      }
    }

    // Check segment count for media playlists
    if (isMedia) {
      const segmentCount = (manifest.match(/#EXTINF:/g) || []).length;
      if (segmentCount > 1000) {
        issues.push(
          this.createIssue(
            HLS_ISSUE_CODES.LARGE_SEGMENT_COUNT,
            'info',
            'best-practice',
            `Large number of segments (${segmentCount})`,
            'Very long playlists can impact memory and parsing performance',
            undefined,
            'General best practice'
          )
        );
      }
    }
  }

  private createIssue(
    code: string,
    severity: HlsIssueSeverity,
    category: HlsIssueCategory,
    message: string,
    details?: string,
    lineNumber?: number,
    specReference?: string
  ): HlsIssue {
    return { code, severity, category, message, details, lineNumber, specReference };
  }

  private buildResult(issues: HlsIssue[]): HlsValidationResult {
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    const info = issues.filter((i) => i.severity === 'info').length;

    return {
      isValid: errors === 0,
      issues: issues.sort((a, b) => {
        const severityOrder = { error: 0, warning: 1, info: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      }),
      summary: { errors, warnings, info },
    };
  }
}
