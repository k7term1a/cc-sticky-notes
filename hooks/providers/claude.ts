// Summary layer over the user's Claude subscription ($.model.complete).
import type { ModelCompleteRequest, ModelCompleteResult, ModelEffort } from 'claude-code'

import type { SummaryInput, SummaryJob, SummaryProvider, SummaryResult } from './types'

const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function asEffort(value: unknown): ModelEffort {
  return EFFORTS.includes(value as ModelEffort) ? (value as ModelEffort) : 'low'
}

export type ClaudeDeps = {
  complete(request: ModelCompleteRequest): Promise<ModelCompleteResult>
  log(text: string): void
}

export function claudeProvider(d: ClaudeDeps, opts: { model: string; effort: ModelEffort; timeoutMs?: number }): SummaryProvider {
  return {
    name: 'claude',
    async summarize(job: SummaryJob, input: SummaryInput): Promise<SummaryResult> {
      const r = await d.complete({
        model: opts.model,
        effort: opts.effort,
        system: input.system,
        prompt: input.prompt,
        maxTokens: input.maxTokens,
        timeoutMs: opts.timeoutMs ?? 60_000,
      })
      const tokens = r.usage.input_tokens + r.usage.output_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens
      d.log(`claude: ${job} · ${tokens} tokens`)
      if (r.isAnswered) return { ok: true, text: r.text, tokens, provider: 'claude' }
      return { ok: false, reason: r.reason === 'aborted' ? 'aborted' : 'error', detail: r.reason, provider: 'claude' }
    },
  }
}
