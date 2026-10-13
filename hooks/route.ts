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
      /** 'followup' goes under `parentId` when given, else under this session's activeThread. */
      attach: 'followup' | 'root'
      parentId?: string
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
export const OTHER_NOTE_LABEL = '接在其他便利貼下…'
export const followupLabel = (title: string) => `接在「${title}」下`

/** 'pick' is 〔接在其他便利貼下…〕: a second dialog chooses the note. */
export type DialogChoice = AskChoice | 'pick'
export type AskPrompt = { question: string; options: { label: string; choice: DialogChoice }[] }

/**
 * The note the dialog offers to follow up: the one Jev says the prompt continues,
 * else this session's activeThread; `likely` is how sure (continues' confidence,
 * or is_followup for the activeThread).
 */
export type Suggested = { id: string; title: string; likely: number }

/**
 * The dialog: Jev's call and confidence in the question;
 * 〔接在「<suggested>」下〕〔開新的便利貼〕, ordered by how likely the follow-up is,
 * then 〔送進主線〕, then 〔接在其他便利貼下…〕 when there are notes besides the
 * suggested one (four options, the dialog's most). No suggestion, no first option.
 */
export function askPrompt(verdict: JevVerdict, ctx: { suggested: Suggested | null; hasOthers: boolean; followupThreshold: number }): AskPrompt {
  const pct = Math.round(verdict.route.confidence * 100)
  const question = `這句要怎麼處理？(Jev：${ROUTE_NAME[verdict.route.label]} ${pct}%)`
  const fresh = { label: NEW_NOTE_LABEL, choice: 'new' as const }
  const main = { label: MAIN_LABEL, choice: 'main' as const }
  const other = ctx.hasOthers ? [{ label: OTHER_NOTE_LABEL, choice: 'pick' as const }] : []
  if (ctx.suggested === null) return { question, options: [fresh, main, ...other] }
  const follow = { label: followupLabel(ctx.suggested.title), choice: 'followup' as const }
  const first = ctx.suggested.likely >= ctx.followupThreshold ? [follow, fresh] : [fresh, follow]
  return { question, options: [...first, main, ...other] }
}

export const PICK_QUESTION = '接在哪一張便利貼下？（不在清單裡就在「其他」打標題的關鍵字）'

/**
 * The second dialog, after 〔接在其他便利貼下…〕: up to four notes as 〔「<title>」〕,
 * a repeated title told apart by a number; 〔送進主線〕 when fewer than two notes
 * (a dialog takes 2–4 options).
 */
export function pickPrompt(notes: readonly { id: string; title: string }[]): { question: string; options: { label: string; id: string | null }[] } {
  const seen = new Map<string, number>()
  const options = notes.slice(0, 4).map(n => {
    const k = (seen.get(n.title) ?? 0) + 1
    seen.set(n.title, k)
    return { label: k === 1 ? `「${n.title}」` : `「${n.title}」(${k})`, id: n.id as string | null }
  })
  if (options.length < 2) options.push({ label: MAIN_LABEL, id: null })
  return { question: PICK_QUESTION, options }
}

/** The label the user picked → their choice; free text under "Other" is none (notes.ts searches it). */
export function choiceOf(prompt: AskPrompt, answer: string): DialogChoice | null {
  return prompt.options.find(o => o.label === answer)?.choice ?? null
}

/**
 * The user's pick → what happens. The node's route records the pick (source 'ask')
 * and Jev's confidence; a follow-up goes under `parentId` (the note picked).
 */
export function decideFromChoice(choice: AskChoice | null, verdict: JevVerdict, tagsKnown: number, parentId?: string): Decision {
  if (choice === null || choice === 'main') return { kind: 'main' }
  return {
    kind: 'sidebar',
    attach: choice === 'followup' ? 'followup' : 'root',
    ...(choice === 'followup' && parentId !== undefined ? { parentId } : {}),
    answerer: verdict.needsProjectCtx >= NEEDS_CTX_AT ? 'fork' : 'summary-provider',
    tag: decideTag(verdict, tagsKnown),
    route: { label: choice, confidence: verdict.route.confidence, source: 'ask' },
  }
}
