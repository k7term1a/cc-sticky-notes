// Routing decision table (PLAN.md「決策表」). Pure: verdict + thresholds in, decision out.
import type { JevVerdict } from './jev'
import { NEW_TAG } from './jev'

export const PROJECT_QUESTION_CONTEXT = '[sticky-notes] project question; answer briefly'

/** Probability at which needs_project_ctx counts as "yes". Not in PLAN.md; see PROBE.md 待討論. */
export const NEEDS_CTX_AT = 0.5
/** Tag confidence below this asks the summary layer for a new name (PLAN.md: < 0.5). */
export const TAG_MIN = 0.5

export type Thresholds = { route: number; followup: number }

export type TagDecision =
  | { kind: 'none' }
  | { kind: 'existing'; tag: string }
  | { kind: 'name-new' }

export type Answerer = 'fork' | 'summary-provider'

export type Decision =
  | { kind: 'main' }
  | {
      kind: 'sidebar'
      attach: 'followup' | 'root'
      answerer: Answerer
      tag: TagDecision
      route: { label: string; confidence: number; source: 'jev' | 'ask' | 'manual' }
    }
  | { kind: 'project_question'; context: string; route: { label: string; confidence: number; source: 'jev' } }
  | { kind: 'ask'; why: 'no-verdict' | 'low-confidence' }

export function decideTag(verdict: JevVerdict, tagsKnown: number): TagDecision {
  if (tagsKnown === 0 || !verdict.tag) return tagsKnown === 0 ? { kind: 'name-new' } : { kind: 'none' }
  if (verdict.tag.label === NEW_TAG || verdict.tag.confidence < TAG_MIN) return { kind: 'name-new' }
  return { kind: 'existing', tag: verdict.tag.label }
}

/**
 * @param verdict Jev's answer, or null when Jev is unavailable (no key, error) → ask.
 * @param hasActiveThread whether this session has an activeThread to follow up on.
 */
export function decide(
  verdict: JevVerdict | null,
  t: Thresholds,
  ctx: { hasActiveThread: boolean; tagsKnown: number },
): Decision {
  if (verdict === null) return { kind: 'ask', why: 'no-verdict' }
  const { label, confidence } = verdict.route
  if (confidence < t.route) return { kind: 'ask', why: 'low-confidence' }

  switch (label) {
    case 'main_task':
      return { kind: 'main' }
    case 'project_question':
      return { kind: 'project_question', context: PROJECT_QUESTION_CONTEXT, route: { label, confidence, source: 'jev' } }
    case 'sidebar_knowledge':
      return {
        kind: 'sidebar',
        attach: ctx.hasActiveThread && verdict.isFollowup >= t.followup ? 'followup' : 'root',
        answerer: verdict.needsProjectCtx >= NEEDS_CTX_AT ? 'fork' : 'summary-provider',
        tag: decideTag(verdict, ctx.tagsKnown),
        route: { label, confidence, source: 'jev' },
      }
  }
}

/** The labels shown in $.ui.ask, in order. */
export const ASK_OPTIONS = ['主線', '旁支（新 note）', '追問旁支'] as const

/**
 * Maps the user's $.ui.ask answer to a decision. A "follow-up" with no active
 * thread becomes a new root. Anything else (free text under "Other") goes to the main line.
 */
export function decideFromAsk(answer: string, ctx: { hasActiveThread: boolean }): Decision {
  const route = { label: 'sidebar_knowledge', confidence: 1, source: 'ask' as const }
  if (answer === ASK_OPTIONS[1]) return { kind: 'sidebar', attach: 'root', answerer: 'fork', tag: { kind: 'none' }, route }
  if (answer === ASK_OPTIONS[2]) {
    return { kind: 'sidebar', attach: ctx.hasActiveThread ? 'followup' : 'root', answerer: 'fork', tag: { kind: 'none' }, route }
  }
  return { kind: 'main' }
}
