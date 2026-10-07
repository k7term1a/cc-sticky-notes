import { describe, expect, test } from 'claude-code/testing'

import type { JevVerdict } from '../hooks/jev'
import { ASK_OPTIONS, decide, decideFromAsk, decideTag, NEEDS_CTX_AT, PROJECT_QUESTION_CONTEXT } from '../hooks/route'

const T = { route: 0.6, followup: 0.6 }

const v = (label: JevVerdict['route']['label'], confidence: number, extra: Partial<JevVerdict> = {}): JevVerdict => ({
  route: { label, confidence },
  isFollowup: 0,
  needsProjectCtx: 1,
  ...extra,
})

const ctx = { hasActiveThread: true, tagsKnown: 2 }

describe('decision table (PLAN.md 決策表)', () => {
  test('main_task ≥ 0.6 → main line', () => {
    expect(decide(v('main_task', 0.6), T, ctx)).toEqual({ kind: 'main' })
  })

  test('sidebar_knowledge ≥ 0.6 → sidebar', () => {
    expect(decide(v('sidebar_knowledge', 0.9), T, ctx).kind).toBe('sidebar')
  })

  test('project_question ≥ 0.6 → main line with context', () => {
    const d = decide(v('project_question', 0.7), T, ctx)
    expect(d).toMatchObject({ kind: 'project_question', context: PROJECT_QUESTION_CONTEXT })
  })

  test('any route below the threshold → ask', () => {
    for (const label of ['main_task', 'sidebar_knowledge', 'project_question'] as const) {
      expect(decide(v(label, 0.59), T, ctx)).toEqual({ kind: 'ask', why: 'low-confidence' })
    }
  })

  test('no verdict (Jev missing or failed) → main line, never a dialog (PLAN.md 沒有 Jev key 時)', () => {
    expect(decide(null, T, ctx)).toEqual({ kind: 'main' })
  })

  test('the threshold comes from config', () => {
    expect(decide(v('main_task', 0.7), { route: 0.8, followup: 0.6 }, ctx).kind).toBe('ask')
  })
})

describe('sidebar details', () => {
  test('is_followup ≥ 0.6 with an active thread → follow-up', () => {
    const d = decide(v('sidebar_knowledge', 0.9, { isFollowup: 0.6 }), T, ctx)
    expect(d).toMatchObject({ kind: 'sidebar', attach: 'followup' })
  })

  test('is_followup below threshold → new root', () => {
    expect(decide(v('sidebar_knowledge', 0.9, { isFollowup: 0.59 }), T, ctx)).toMatchObject({ attach: 'root' })
  })

  test('no active thread → new root even when Jev says follow-up', () => {
    const d = decide(v('sidebar_knowledge', 0.9, { isFollowup: 0.99 }), T, { ...ctx, hasActiveThread: false })
    expect(d).toMatchObject({ attach: 'root' })
  })

  test('needs_project_ctx ≥ 0.3 picks the fork; below, the summary provider', () => {
    expect(NEEDS_CTX_AT).toBe(0.3)
    expect(decide(v('sidebar_knowledge', 0.9, { needsProjectCtx: 0.3 }), T, ctx)).toMatchObject({ answerer: 'fork' })
    expect(decide(v('sidebar_knowledge', 0.9, { needsProjectCtx: 0.29 }), T, ctx)).toMatchObject({ answerer: 'summary-provider' })
  })

  test('route provenance is recorded for threshold calibration', () => {
    expect(decide(v('sidebar_knowledge', 0.83), T, ctx)).toMatchObject({ route: { label: 'sidebar_knowledge', confidence: 0.83, source: 'jev' } })
  })
})

describe('tags', () => {
  test('an existing tag with confidence ≥ 0.5 is used', () => {
    expect(decideTag(v('sidebar_knowledge', 1, { tag: { label: 'db', confidence: 0.5 } }), 2)).toEqual({ kind: 'existing', tag: 'db' })
  })

  test('__new__ or low confidence asks for a new name', () => {
    expect(decideTag(v('sidebar_knowledge', 1, { tag: { label: '__new__', confidence: 0.9 } }), 2)).toEqual({ kind: 'name-new' })
    expect(decideTag(v('sidebar_knowledge', 1, { tag: { label: 'db', confidence: 0.49 } }), 2)).toEqual({ kind: 'name-new' })
  })

  test('with no tags yet, Jev skips the question and a name is made', () => {
    expect(decideTag(v('sidebar_knowledge', 1), 0)).toEqual({ kind: 'name-new' })
  })
})

describe('$.ui.ask answers', () => {
  test('main / new note / follow-up', () => {
    expect(decideFromAsk(ASK_OPTIONS[0], { hasActiveThread: true })).toEqual({ kind: 'main' })
    expect(decideFromAsk(ASK_OPTIONS[1], { hasActiveThread: true })).toMatchObject({ kind: 'sidebar', attach: 'root', route: { source: 'ask' } })
    expect(decideFromAsk(ASK_OPTIONS[2], { hasActiveThread: true })).toMatchObject({ kind: 'sidebar', attach: 'followup' })
  })

  test('follow-up with nothing to follow → new root; free text → main line', () => {
    expect(decideFromAsk(ASK_OPTIONS[2], { hasActiveThread: false })).toMatchObject({ attach: 'root' })
    expect(decideFromAsk('whatever I typed', { hasActiveThread: true })).toEqual({ kind: 'main' })
  })
})
