// Side answers: $.model.fork when the question needs the project, else the summary provider.
import type { ModelForkResult } from 'claude-code'

import type { AnsweredBy } from '../types'
import type { SummaryProvider } from './providers/types'

export type QA = { question: string; answer: string }

const FORK_FRAME =
  '[sticky-notes] The user asked this as an aside. Answer the aside directly and concisely; ' +
  'do not continue, plan or change the main task, and do not call tools.'

/**
 * ModelForkRequest is `{ prompt }` only (no system, no extra messages), so the
 * side thread's history is written into the prompt text. See PROBE.md.
 */
export function buildForkPrompt(history: readonly QA[], question: string): string {
  const parts = [FORK_FRAME]
  if (history.length > 0) {
    parts.push('', '[side thread so far]')
    history.forEach((qa, i) => parts.push(`Q${i + 1}: ${qa.question}`, `A${i + 1}: ${qa.answer}`))
  }
  parts.push('', '[question]', question)
  return parts.join('\n')
}

export const KNOWLEDGE_SYSTEM =
  'You answer short background-knowledge questions for a developer. Be accurate and concise; ' +
  'use Markdown. You do not see their project, so do not guess about it.'

export function buildKnowledgePrompt(history: readonly QA[], question: string): string {
  const lines = history.flatMap((qa, i) => [`Q${i + 1}: ${qa.question}`, `A${i + 1}: ${qa.answer}`])
  return (lines.length ? `Earlier in this thread:\n${lines.join('\n')}\n\n` : '') + `Question: ${question}`
}

export type SideAnswer =
  | { ok: true; text: string; answeredBy: AnsweredBy }
  | { ok: false; reason: string }

export async function answerSide(
  fork: (prompt: string) => Promise<ModelForkResult>,
  q: { question: string; history: readonly QA[]; answerer: 'fork' | 'summary-provider' },
  provider: SummaryProvider | null,
): Promise<SideAnswer> {
  if (q.answerer === 'summary-provider' && provider) {
    const r = await provider.summarize('knowledge-answer', {
      system: KNOWLEDGE_SYSTEM,
      prompt: buildKnowledgePrompt(q.history, q.question),
      maxTokens: 1500,
      hasProjectContent: false,
    })
    if (r.ok) return { ok: true, text: r.text, answeredBy: r.provider }
    // fall through to the fork: PLAN.md「缺 OpenAI → 全部走 $.model.fork」
  }
  const r = await fork(buildForkPrompt(q.history, q.question))
  if (r.isAnswered) return { ok: true, text: r.text, answeredBy: 'claude-fork' }
  if (r.reason === 'nothing-to-fork' && provider) {
    // A brand-new session (or right after /clear) has no transcript to fork:
    // answer without project context through the summary provider.
    const c = await provider.summarize('knowledge-answer', {
      system: KNOWLEDGE_SYSTEM,
      prompt: buildKnowledgePrompt(q.history, q.question),
      maxTokens: 1500,
      hasProjectContent: false,
    })
    return c.ok ? { ok: true, text: c.text, answeredBy: c.provider } : { ok: false, reason: c.reason }
  }
  return { ok: false, reason: r.reason }
}
