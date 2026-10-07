// TypeSafe Jev client. The only file that knows Jev's request/response schema.
// Schema source: third-party write-up (apidog.com/blog/what-is-jev), NOT yet checked
// against console.typesafe.ai — see PROBE.md. Endpoint reachability is verified
// (403 "Must supply an API key!" without a key).
import type { HttpInit, HttpResponse } from 'claude-code'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

export type RouteLabel = 'main_task' | 'sidebar_knowledge' | 'project_question'
export const NEW_TAG = '__new__'

/** What the rest of the mod sees: schema-free. */
export type JevVerdict = {
  route: { label: RouteLabel; confidence: number }
  /** Probability that the prompt continues the active thread. */
  isFollowup: number
  /** Probability that answering needs the project's code or conversation. */
  needsProjectCtx: number
  /** Absent when there were no tags to choose from. */
  tag?: { label: string; confidence: number }
}

export type JevInput = {
  /** Last user prompts (oldest first) and the last assistant reply, raw. */
  recentUser: string[]
  lastAssistant: string | null
  activeTitle: string | null
  activeLastQuestion: string | null
  mainTurnsSinceLastSidebar: number
  prompt: string
  tags: string[]
}

const CLIP = 300

const clip = (s: string) => ([...s].length > CLIP ? [...s].slice(0, CLIP).join('') + '…' : s)

/** The `state` text, as PLAN.md「Jev 分類設計」lays it out. */
export function buildState(input: JevInput): string {
  const recent = [...input.recentUser.slice(-3).map(u => `user: ${clip(u)}`)]
  if (input.lastAssistant !== null) recent.push(`assistant: ${clip(input.lastAssistant)}`)
  return [
    '[recent main-line context]',
    recent.length ? recent.join('\n') : '(none)',
    '',
    '[sidebar state]',
    `active_thread_title: ${input.activeTitle ?? 'none'}`,
    `active_thread_last_question: ${input.activeLastQuestion ?? 'none'}`,
    `main_turns_since_last_sidebar: ${input.mainTurnsSinceLastSidebar}`,
    '',
    '[new prompt]',
    input.prompt,
  ].join('\n')
}

export function buildRequest(input: JevInput): unknown {
  const questions: Record<string, unknown> = {
    route: {
      type: 'choice',
      instructions: 'Where should the new prompt go?',
      criteria: {
        main_task: 'Advances the project: an instruction, a code change, or a decision about what Claude just did',
        sidebar_knowledge: 'Asks about a principle, concept or background knowledge; does not ask Claude to change anything',
        project_question:
          'A question about this project itself whose answer belongs in the main conversation: it refers to "we", "our", "here", ' +
          '"this project" or to code and decisions in this conversation, e.g. "why do we use session cookies here instead of JWT?", ' +
          '"為什麼我們這裡用 X？", "這個專案為什麼要這樣分層？"',
      },
    },
    is_followup: {
      type: 'noul',
      instructions: 'Does the new prompt continue the topic of active_thread?',
    },
    needs_project_ctx: {
      type: 'noul',
      instructions: "Does answering the new prompt require seeing the project's code or conversation?",
    },
  }
  if (input.tags.length > 0) {
    const criteria: Record<string, string> = {}
    for (const t of input.tags) criteria[t] = `About ${t}`
    criteria[NEW_TAG] = 'None of the existing tags fits'
    questions.tag = { type: 'choice', instructions: 'Which topic tag fits the new prompt?', criteria }
  }
  return { model: JEV_MODEL, state: buildState(input), questions }
}

type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number }
type NoulAnswer = { type: 'noul'; noul: number }

const isRoute = (s: unknown): s is RouteLabel =>
  s === 'main_task' || s === 'sidebar_knowledge' || s === 'project_question'

/** Response → JevVerdict; null when the shape is not what we expect. */
export function parseResponse(body: unknown): JevVerdict | null {
  const answers = (body as { answers?: Record<string, unknown> } | null)?.answers
  if (!answers) return null
  const route = answers.route as ChoiceAnswer | undefined
  const fu = answers.is_followup as NoulAnswer | undefined
  const ctx = answers.needs_project_ctx as NoulAnswer | undefined
  if (!route || !isRoute(route.choice) || typeof route.confidence !== 'number') return null
  if (typeof fu?.noul !== 'number' || typeof ctx?.noul !== 'number') return null
  const verdict: JevVerdict = {
    route: { label: route.choice, confidence: route.confidence },
    isFollowup: fu.noul,
    needsProjectCtx: ctx.noul,
  }
  const tag = answers.tag as ChoiceAnswer | undefined
  if (tag && typeof tag.choice === 'string' && typeof tag.confidence === 'number') {
    verdict.tag = { label: tag.choice, confidence: tag.confidence }
  }
  return verdict
}

export type JevResult =
  | { ok: true; verdict: JevVerdict; ms: number }
  | { ok: false; reason: 'no-key' | 'http' | 'bad-response' | 'network'; status?: number; ms: number }

export type JevDeps = {
  key: string | undefined
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  now(): Promise<number>
}

/** One classification call. Never throws; the caller degrades to $.ui.ask on !ok. */
export async function classify(d: JevDeps, input: JevInput): Promise<JevResult> {
  const t0 = await d.now()
  const ms = async () => (await d.now()) - t0
  const key = d.key
  if (!key) return { ok: false, reason: 'no-key', ms: 0 }
  try {
    const r = await d.fetch(JEV_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(buildRequest(input)),
    })
    if (!r.ok) return { ok: false, reason: 'http', status: r.status, ms: await ms() }
    let body: unknown
    try {
      body = JSON.parse(r.text)
    } catch {
      return { ok: false, reason: 'bad-response', status: r.status, ms: await ms() }
    }
    const verdict = parseResponse(body)
    return verdict ? { ok: true, verdict, ms: await ms() } : { ok: false, reason: 'bad-response', status: r.status, ms: await ms() }
  } catch {
    return { ok: false, reason: 'network', ms: await ms() }
  }
}
