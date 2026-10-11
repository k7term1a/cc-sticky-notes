// Routing decision table (PLAN.md「決策表」). Pure: verdict + thresholds in, decision out.
//
// Jev never makes a sticky note by itself (the developer, 10/07): it only lets a
// confident main-line prompt through. Everything that might be a note asks the
// user, and the user's pick decides.
//
//   no verdict (no key, Jev error)             → main, no dialog
//   main_task,        confidence ≥ threshold    → main, no dialog
//   main_task,        confidence < threshold    → ask
//   sidebar_knowledge, any confidence           → ask
//   project_question, confidence ≥ threshold    → main + context (no note)
//   project_question, confidence < threshold    → ask
import type { AskChoice } from '../types'
import type { JevVerdict, RouteLabel } from './jev'
import { NEW_TAG } from './jev'

export const PROJECT_QUESTION_CONTEXT = '[sticky-notes] project question; answer briefly'

/** needs_project_ctx at or above this goes to $.model.fork (PLAN.md: 0.3, conservative — less leaves Anthropic). */
export const NEEDS_CTX_AT = 0.3
/** Tag confidence below this asks the summary layer for a new name (PLAN.md: < 0.5). */
export const TAG_MIN = 0.5

export type Thresholds = { route: number; followup: number }

export type TagDecision =
  | { kind: 'none' }
  | { kind: 'existing'; tag: string }
  | { kind: 'name-new' }

export type Answerer = 'fork' | 'summary-provider'

export type { AskChoice }

export type Decision =
  | { kind: 'main' }
  | { kind: 'project_question'; context: string; route: { label: string; confidence: number; source: 'jev' } }
  | { kind: 'ask'; why: 'sidebar' | 'low-confidence' }
  /** Only ever made from the user's pick (decideFromChoice) or a manual entry. */
  | {
      kind: 'sidebar'
      attach: 'followup' | 'root'
      answerer: Answerer
      tag: TagDecision
      route: { label: string; confidence: number; source: 'jev' | 'ask' | 'manual' }
    }

export function decideTag(verdict: JevVerdict, tagsKnown: number): TagDecision {
  if (tagsKnown === 0 || !verdict.tag) return tagsKnown === 0 ? { kind: 'name-new' } : { kind: 'none' }
  if (verdict.tag.label === NEW_TAG || verdict.tag.confidence < TAG_MIN) return { kind: 'name-new' }
  return { kind: 'existing', tag: verdict.tag.label }
}

/**
 * @param verdict Jev's answer, or null when Jev is unavailable (no key, error):
 *   everything goes to the main line and only the manual entries make notes.
 */
export function decide(verdict: JevVerdict | null, t: Thresholds): Decision {
  if (verdict === null) return { kind: 'main' }
  const { label, confidence } = verdict.route
  switch (label) {
    case 'main_task':
      return confidence >= t.route ? { kind: 'main' } : { kind: 'ask', why: 'low-confidence' }
    case 'sidebar_knowledge':
      return { kind: 'ask', why: 'sidebar' }
    case 'project_question':
      return confidence >= t.route
        ? { kind: 'project_question', context: PROJECT_QUESTION_CONTEXT, route: { label, confidence, source: 'jev' } }
        : { kind: 'ask', why: 'low-confidence' }
  }
}

const ROUTE_NAME: Record<RouteLabel, string> = {
  main_task: '主線任務',
  sidebar_knowledge: '知識旁問',
  project_question: '專案疑問',
}

export const NEW_NOTE_LABEL = '開新的便利貼'
export const MAIN_LABEL = '送進主線'
export const followupLabel = (title: string) => `接在「${title}」下`

export type AskPrompt = { question: string; options: { label: string; choice: AskChoice }[] }

/**
 * The dialog: Jev's call and confidence in the question; with an active thread
 * 〔接在「…」下〕〔開新的便利貼〕〔送進主線〕, the first two ordered by is_followup;
 * without one 〔開新的便利貼〕〔送進主線〕.
 */
export function askPrompt(verdict: JevVerdict, ctx: { activeTitle: string | null; followupThreshold: number }): AskPrompt {
  const pct = Math.round(verdict.route.confidence * 100)
  const question = `這句要怎麼處理？(Jev：${ROUTE_NAME[verdict.route.label]} ${pct}%)`
  const fresh = { label: NEW_NOTE_LABEL, choice: 'new' as const }
  const main = { label: MAIN_LABEL, choice: 'main' as const }
  if (ctx.activeTitle === null) return { question, options: [fresh, main] }
  const follow = { label: followupLabel(ctx.activeTitle), choice: 'followup' as const }
  const first = verdict.isFollowup >= ctx.followupThreshold ? [follow, fresh] : [fresh, follow]
  return { question, options: [...first, main] }
}

/** The label the user picked → their choice; free text under "Other" is no choice (main line). */
export function choiceOf(prompt: AskPrompt, answer: string): AskChoice | null {
  return prompt.options.find(o => o.label === answer)?.choice ?? null
}

/** The user's pick → what happens. The node's route records the pick (source 'ask') and Jev's confidence. */
export function decideFromChoice(choice: AskChoice | null, verdict: JevVerdict, tagsKnown: number): Decision {
  if (choice === null || choice === 'main') return { kind: 'main' }
  return {
    kind: 'sidebar',
    attach: choice === 'followup' ? 'followup' : 'root',
    answerer: verdict.needsProjectCtx >= NEEDS_CTX_AT ? 'fork' : 'summary-provider',
    tag: decideTag(verdict, tagsKnown),
    route: { label: choice, confidence: verdict.route.confidence, source: 'ask' },
  }
}
