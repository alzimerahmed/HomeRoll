import { Inject, Injectable } from '@nestjs/common';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/**
 * FG-13 (HomeRoll): pluggable LLM-provider layer for "Ask HomeRoll".
 *
 * No cloud provider is hardcoded and no SDK dependency is added: the only
 * built-in provider speaks the OpenAI-compatible `/chat/completions` wire
 * format (works with llama.cpp, Ollama, vLLM, LM Studio, OpenAI itself, ...),
 * configured entirely via env vars:
 *
 * - `IMMICH_ASK_LLM_BASE_URL` — e.g. `http://ollama:11434/v1/` (unset = no LLM)
 * - `IMMICH_ASK_LLM_API_KEY` — optional bearer token
 * - `IMMICH_ASK_LLM_MODEL` — model name (default `gpt-4o-mini`-agnostic: required when a URL is set)
 * - `IMMICH_ASK_LLM_TIMEOUT_MS` — request timeout (default 30s)
 *
 * When no provider is configured, `getProvider()` returns null and the ask
 * service degrades to the deterministic "structured answer" path — the feature
 * never depends on a cloud service.
 */
export interface LlmProvider {
  /** Single-turn completion over the user's library context. */
  chat(systemPrompt: string, userPrompt: string): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on context size sent to the model — keeps local models responsive. */
const MAX_CONTEXT_CHARS = 24_000;
/** Cap on the LLM response body — a misbehaving endpoint must not OOM the server. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** Reads a response body with a hard byte cap. */
const readCapped = async (response: Response, limit: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('LLM endpoint returned no body');
  }

  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) {
      await reader.cancel();
      throw new Error(`LLM response exceeded ${limit} bytes`);
    }
  }
};

@Injectable()
export class LlmService {
  constructor(
    @Inject(ConfigRepository) private configRepository: ConfigRepository,
    @Inject(LoggingRepository) private logger: LoggingRepository,
  ) {
    this.logger.setContext(LlmService.name);
  }

  /** The configured provider, or null when no LLM endpoint is set. */
  getProvider(): LlmProvider | null {
    const { ask } = this.configRepository.getEnv();
    if (!ask?.llmBaseUrl) {
      return null;
    }

    if (!ask.llmModel) {
      this.logger.warn(
        'IMMICH_ASK_LLM_BASE_URL is set but IMMICH_ASK_LLM_MODEL is missing — ignoring the LLM provider',
      );
      return null;
    }

    // URL('relative', base) drops the base path without a trailing slash
    const baseUrl = ask.llmBaseUrl.endsWith('/') ? ask.llmBaseUrl : `${ask.llmBaseUrl}/`;
    const apiKey = ask.llmApiKey;
    const model = ask.llmModel;
    const timeoutMs = ask.llmTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    return {
      chat: async (systemPrompt: string, userPrompt: string) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(new URL('chat/completions', baseUrl), {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt.slice(0, MAX_CONTEXT_CHARS) },
              ],
              temperature: 0.2,
              max_tokens: 512,
              stream: false,
            }),
          });

          if (!response.ok) {
            throw new Error(`LLM endpoint returned ${response.status}: ${response.statusText}`);
          }

          const body = JSON.parse(await readCapped(response, MAX_RESPONSE_BYTES)) as {
            choices?: { message?: { content?: string } }[];
          };
          const content = body.choices?.[0]?.message?.content;
          if (!content) {
            throw new Error('LLM endpoint returned no content');
          }

          return content;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  /** True when an LLM endpoint is configured (surfaced via server features). */
  isConfigured(): boolean {
    return this.getProvider() !== null;
  }
}
