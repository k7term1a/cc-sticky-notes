// Summary layer jobs. M1: the automatic title + three-sentence summary per node.
// Outline / main digest / tag merge / digest-export are manual jobs for M3–M4.
import type { SummaryProvider } from './providers/types'
import { fallbackTitle, TITLE_MAX } from './tree'

/** Same language as the question; Chinese is always Traditional Chinese (Taiwan usage). */
export const LANGUAGE_RULE =
  'Write in the same language as the question. If the question is in Chinese, write in Traditional Chinese ' +
  'as used in Taiwan (繁體中文), never Simplified Chinese.'

/** A topic tag: a few words, the card's category (10/14). */
export const TAG_MAX = 8

const titleSystem = (tags: readonly string[]) =>
  `Write a title of at most ${TITLE_MAX} characters and a summary of exactly three sentences for this Q/A, ` +
  `and a topic tag of at most ${TAG_MAX} characters naming its field (e.g. 資料結構, 網路, 統計). ` +
  (tags.length > 0 ? `Reuse one of these existing tags when it fits: ${tags.join(', ')}. ` : '') +
  `${LANGUAGE_RULE} Reply with JSON only: {"title": "...", "summary": "...", "tag": "..."}`

export function titlePrompt(question: string, answer: string): string {
  return `Question:\n${question}\n\nAnswer:\n${answer.slice(0, 6000)}`
}

/** Accepts a bare JSON object or one wrapped in a ```json fence. */
export function parseTitleSummary(text: string): { title: string; summary: string; tag?: string } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { title?: unknown; summary?: unknown; tag?: unknown }
    if (typeof o.title !== 'string' || typeof o.summary !== 'string' || o.title.trim() === '') return null
    const tag = typeof o.tag === 'string' && o.tag.trim() !== '' ? [...o.tag.trim().replace(/^#/, '')].slice(0, TAG_MAX).join('') : undefined
    return { title: [...o.title.trim()].slice(0, TITLE_MAX).join(''), summary: o.summary.trim(), ...(tag ? { tag } : {}) }
  } catch {
    return null
  }
}

/** Never fails: falls back to the question's first 12 chars and no summary. */
export async function titleAndSummary(
  provider: SummaryProvider,
  question: string,
  answer: string,
  tags: readonly string[] = [],
): Promise<{ title: string; summary: string | null; tag?: string; tokens: number }> {
  const r = await provider.summarize('node-title-summary', {
    system: titleSystem(tags),
    prompt: titlePrompt(question, answer),
    maxTokens: 400,
    hasProjectContent: true,
  })
  const parsed = r.ok ? parseTitleSummary(r.text) : null
  if (!parsed) return { title: fallbackTitle(question), summary: null, tokens: r.ok ? r.tokens : 0 }
  return { ...parsed, tokens: r.ok ? r.tokens : 0 }
}
