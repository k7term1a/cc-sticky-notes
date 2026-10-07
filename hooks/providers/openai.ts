// Summary layer over OpenAI chat completions — M4. Interface only for now:
// the request shape is in place; redact.ts wiring, the daily cap and usage
// counting land in M4 (PLAN.md). Without OPENAI_API_KEY it reports unavailable.
import type { HttpInit, HttpResponse } from 'claude-code'

import type { SummaryInput, SummaryJob, SummaryProvider, SummaryResult } from './types'

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

export type OpenAIContextMode = 'off' | 'redacted' | 'full'

/**
 * gpt-5 family models reason before answering; with the default effort a small
 * max_completion_tokens is spent on reasoning alone and the reply is empty
 * (PROBE.md, round two). 'minimal' answered summary jobs in ~150 tokens.
 */
export type OpenAIReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'none'

export function asReasoningEffort(value: unknown): OpenAIReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'none' ? value : 'minimal'
}

export function asContextMode(value: unknown): OpenAIContextMode {
  return value === 'off' || value === 'full' ? value : 'redacted'
}

export type OpenAIDeps = {
  key(): Promise<string | undefined>
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  log(text: string): void
}

export function openaiProvider(
  d: OpenAIDeps,
  opts: { model: string; contextMode: OpenAIContextMode; reasoningEffort: OpenAIReasoningEffort },
): SummaryProvider {
  return {
    name: 'openai',
    async summarize(job: SummaryJob, input: SummaryInput): Promise<SummaryResult> {
      if (opts.contextMode === 'off' && input.hasProjectContent) {
        return { ok: false, reason: 'refused-by-mode', provider: 'openai' }
      }
      const key = await d.key()
      if (!key) return { ok: false, reason: 'unavailable', detail: 'OPENAI_API_KEY unset', provider: 'openai' }
      // TODO(M4): redact(input) when contextMode === 'redacted'; daily cap; usage store.
      try {
        const r = await d.fetch(OPENAI_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: opts.model,
            max_completion_tokens: input.maxTokens,
            // 'none' leaves the parameter out, for models that do not take it
            ...(opts.reasoningEffort === 'none' ? {} : { reasoning_effort: opts.reasoningEffort }),
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.prompt },
            ],
          }),
        })
        if (!r.ok) return { ok: false, reason: 'error', detail: `http ${r.status}`, provider: 'openai' }
        const body = JSON.parse(r.text) as {
          choices?: { message?: { content?: string } }[]
          usage?: { total_tokens?: number }
        }
        const text = body.choices?.[0]?.message?.content ?? ''
        const tokens = body.usage?.total_tokens ?? 0
        d.log(`openai: ${job} · ${tokens} tokens · mode=${opts.contextMode}`)
        return text ? { ok: true, text, tokens, provider: 'openai' } : { ok: false, reason: 'error', detail: 'empty', provider: 'openai' }
      } catch (err) {
        return { ok: false, reason: 'error', detail: String(err), provider: 'openai' }
      }
    },
  }
}
