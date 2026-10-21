/**
 * HomeRoll-specific API calls that are not yet part of the generated `@immich/sdk`
 * (the SDK regenerates from the OpenAPI spec in CI via `regen.yml` — see ADR-003/ADR-007).
 *
 * These endpoints exist server-side (Phase 7a) but are missing from the generated SDK
 * until the next spec regeneration. When the SDK is regenerated, these wrappers should
 * be swapped over to their `@immich/sdk` equivalents and this module retired.
 *
 * Auth: same-origin session cookies (or `?apiKey=` for shared-link contexts), matching
 * how the SDK's fetch client authenticates. No extra headers are needed.
 */
import { getBaseUrl } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';

/** Mirrors `AskInterpretationDto` (server/src/dtos/ask.dto.ts) until SDK regen. */
export interface AskInterpretationDto {
  query: string | null;
  city: string | null;
  country: string | null;
  takenAfter: string | null;
  takenBefore: string | null;
  mediaType: 'IMAGE' | 'VIDEO' | null;
  favorited: boolean | null;
  ocr: string | null;
}

/** Mirrors `AskResponseDto` (server/src/dtos/ask.dto.ts) until SDK regen. */
export interface AskResponseDto {
  answer: string;
  provider: 'llm' | 'structured';
  interpretation: AskInterpretationDto;
  assets: import('@immich/sdk').AssetResponseDto[];
  total: number;
}

/** Mirrors `AutoCreationType` (server/src/dtos/auto-creation.dto.ts) until SDK regen. */
export enum AutoCreationType {
  Collage = 'collage',
  Animation = 'animation',
  TripHighlights = 'trip-highlights',
}

/** Mirrors `AutoCreationStatusDto` (server/src/dtos/auto-creation.dto.ts) until SDK regen. */
export interface AutoCreationStatusDto {
  type: AutoCreationType;
}

/** Mirrors `VideoTrimDto` (server/src/dtos/video-trim.dto.ts) until SDK regen — FG-15, ADR-021. */
export interface VideoTrimRequestDto {
  startSeconds: number;
  endSeconds: number;
}

export interface VideoTrimResponseDto {
  assetId: string;
}

class HomerollApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'HomerollApiError';
  }
}

const request = async <T>(path: string, body: unknown): Promise<T> => {
  const params = new URLSearchParams(
    Object.entries(authManager.params).filter(([, value]) => value !== undefined) as [string, string][],
  ).toString();
  const url = `${getBaseUrl()}${path}${params ? `?${params}` : ''}`;

  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new HomerollApiError(`${path} failed`, response.status);
  }

  return (await response.json()) as T;
};

/** POST /api/ask — natural-language question over the library (FG-13). */
export const askHomeRoll = (query: string, size = 100) => request<AskResponseDto>('/ask', { query, size });

/** POST /api/auto-creations/run — queue an auto-creation job (FG-14). */
export const runAutoCreation = (type: AutoCreationType) =>
  request<AutoCreationStatusDto>('/auto-creations/run', { type });

/** POST /api/videos/:id/trim — queue a server-side ffmpeg trim (FG-15, ADR-021). */
export const trimVideo = (assetId: string, dto: VideoTrimRequestDto) =>
  request<VideoTrimResponseDto>(`/videos/${assetId}/trim`, dto);
