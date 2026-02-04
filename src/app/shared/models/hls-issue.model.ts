/**
 * HLS Specification Issue Types
 * Based on RFC 8216bis (HTTP Live Streaming 2nd Edition)
 */

export type HlsIssueSeverity = 'error' | 'warning' | 'info';

export type HlsIssueCategory =
  | 'structure'
  | 'required-tag'
  | 'duration'
  | 'master-playlist'
  | 'media-playlist'
  | 'compatibility'
  | 'best-practice';

export interface HlsIssue {
  code: string;
  severity: HlsIssueSeverity;
  category: HlsIssueCategory;
  message: string;
  details?: string;
  lineNumber?: number;
  specReference?: string;
}

export interface HlsValidationResult {
  isValid: boolean;
  issues: HlsIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}

/**
 * HLS Issue Codes
 */
export const HLS_ISSUE_CODES = {
  // Structure Issues (S)
  MISSING_EXTM3U: 'S001',
  EXTM3U_NOT_FIRST: 'S002',
  EMPTY_MANIFEST: 'S003',
  INVALID_LINE_FORMAT: 'S004',

  // Required Tag Issues (R)
  MISSING_TARGET_DURATION: 'R001',
  MISSING_EXTINF: 'R002',
  MISSING_MEDIA_SEQUENCE_LIVE: 'R003',
  MISSING_ENDLIST_VOD: 'R004',
  MISSING_VERSION: 'R005',

  // Duration Issues (D)
  EXTINF_EXCEEDS_TARGET: 'D001',
  INCONSISTENT_SEGMENT_DURATION: 'D002',
  ZERO_DURATION_SEGMENT: 'D003',
  NEGATIVE_DURATION: 'D004',

  // Master Playlist Issues (M)
  MISSING_BANDWIDTH: 'M001',
  MISSING_CODECS: 'M002',
  MISSING_RESOLUTION: 'M003',
  DUPLICATE_BANDWIDTH: 'M004',
  MISSING_FRAME_RATE: 'M005',
  NO_VARIANTS: 'M006',

  // Media Playlist Issues (P)
  DISCONTINUITY_WITHOUT_SEQUENCE: 'P001',
  INVALID_MEDIA_SEQUENCE: 'P002',
  SEGMENT_URL_INVALID: 'P003',
  MISSING_SEGMENT_AFTER_EXTINF: 'P004',

  // Compatibility Issues (C)
  VERSION_MISMATCH: 'C001',
  FLOATING_POINT_EXTINF_V2: 'C002',
  UNSUPPORTED_TAG_FOR_VERSION: 'C003',

  // Best Practice Issues (B)
  TOO_FEW_SEGMENTS_LIVE: 'B001',
  LARGE_SEGMENT_COUNT: 'B002',
  MISSING_INDEPENDENT_SEGMENTS: 'B003',
  HIGH_TARGET_DURATION: 'B004',
  NO_AUDIO_GROUP: 'B005',
} as const;
