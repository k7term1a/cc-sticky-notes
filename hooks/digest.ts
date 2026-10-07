// Summary layer jobs. M1: the automatic title + three-sentence summary per node.
// Outline / main digest / tag merge / digest-export are manual jobs for M3–M4.
import type { SummaryProvider } from './providers/types'
import { fallbackTitle, TITLE_MAX } from './tree'

/** Same language as the question; Chinese is always Traditional Chinese (Taiwan usage). */
export const LANGUAGE_RULE =
  'Write in the same language as the question. If the question is in Chinese, write in Traditional Chinese ' +
  'as used in Taiwan (繁體中文), never Simplified Chinese.'

const TITLE_SYSTEM =
  `Write a title of at most ${TITLE_MAX} characters and a summary of exactly three sentences for this Q/A. ` +
  `${LANGUAGE_RULE} Reply with JSON only: {"title": "...", "summary": "..."}`

export function titlePrompt(question: string, answer: string): string {
  return `Question:\n${question}\n\nAnswer:\n${answer.slice(0, 6000)}`
}

/** Accepts a bare JSON object or one wrapped in a ```json fence. */
export function parseTitleSummary(text: string): { title: string; summary: string } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { title?: unknown; summary?: unknown }
    if (typeof o.title !== 'string' || typeof o.summary !== 'string' || o.title.trim() === '') return null
    return { title: [...o.title.trim()].slice(0, TITLE_MAX).join(''), summary: o.summary.trim() }
  } catch {
    return null
  }
}

/** Never fails: falls back to the question's first 12 chars and no summary. */
export async function titleAndSummary(
  provider: SummaryProvider,
  question: string,
  answer: string,
): Promise<{ title: string; summary: string | null; tokens: number }> {
  const r = await provider.summarize('node-title-summary', {
    system: TITLE_SYSTEM,
    prompt: titlePrompt(question, answer),
    maxTokens: 400,
    hasProjectContent: true,
  })
  const parsed = r.ok ? parseTitleSummary(r.text) : null
  if (!parsed) return { title: fallbackTitle(question), summary: null, tokens: r.ok ? r.tokens : 0 }
  return { ...parsed, tokens: r.ok ? r.tokens : 0 }
}
