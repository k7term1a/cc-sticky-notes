// The summary layer's one interface (PLAN.md「統整層與模型供應者」).
// digest.ts calls summarize(job, input); providers/claude.ts and providers/openai.ts implement it.

export type SummaryJob =
  | 'node-title-summary'
  | 'tag-name'
  | 'outline'
  | 'outline-refresh'
  | 'main-digest'
  | 'tag-merge'
  | 'digest'
  | 'knowledge-answer'

/** Jobs that run without the user pressing anything. Everything else is manual. */
export const AUTO_JOBS: ReadonlySet<SummaryJob> = new Set(['node-title-summary', 'tag-name'])

export type SummaryInput = {
  system: string
  prompt: string
  maxTokens: number
  /** Whether the input carries project content (main-line text). Gates openaiContextMode=off. */
  hasProjectContent: boolean
}

export type SummaryResult =
  | { ok: true; text: string; tokens: number; provider: ProviderName }
  | { ok: false; reason: 'unavailable' | 'over-cap' | 'refused-by-mode' | 'error' | 'aborted'; detail?: string; provider: ProviderName }

export type ProviderName = 'claude' | 'openai'

export interface SummaryProvider {
  readonly name: ProviderName
  summarize(job: SummaryJob, input: SummaryInput): Promise<SummaryResult>
}

/** PLAN.md: rough estimate shown on buttons, characters ÷ 2. */
export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 2)
}
