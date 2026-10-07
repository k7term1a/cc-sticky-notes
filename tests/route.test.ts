import { describe, expect, test } from 'claude-code/testing'

import type { JevVerdict } from '../hooks/jev'
import {
  askPrompt,
  choiceOf,
  decide,
  decideFromChoice,
  decideTag,
  followupLabel,
  MAIN_LABEL,
  NEEDS_CTX_AT,
  NEW_NOTE_LABEL,
  PROJECT_QUESTION_CONTEXT,
} from '../hooks/route'

const T = { route: 0.6, followup: 0.6 }

const v = (label: JevVerdict['route']['label'], confidence: number, extra: Partial<JevVerdict> = {}): JevVerdict => ({
  route: { label, confidence },
  isFollowup: 0,
  needsProjectCtx: 1,
  ...extra,
})

describe('decision table (PLAN.md 決策表): Jev never makes a note by itself', () => {
  test('main_task ≥ threshold → main line, no dialog', () => {
    expect(decide(v('main_task', 0.6), T)).toEqual({ kind: 'main' })
    expect(decide(v('main_task', 1), T)).toEqual({ kind: 'main' })
  })

  test('main_task below threshold → ask', () => {
    expect(decide(v('main_task', 0.59), T)).toEqual({ kind: 'ask', why: 'low-confidence' })
  })

  test('sidebar_knowledge at any confidence → ask', () => {
    for (const c of [0.1, 0.6, 0.99, 1]) expect(decide(v('sidebar_knowledge', c), T)).toEqual({ kind: 'ask', why: 'sidebar' })
  })

  test('project_question ≥ threshold → main line with context; below → ask', () => {
    expect(decide(v('project_question', 0.7), T)).toMatchObject({ kind: 'project_question', context: PROJECT_QUESTION_CONTEXT })
    expect(decide(v('project_question', 0.5), T)).toEqual({ kind: 'ask', why: 'low-confidence' })
  })

  test('no verdict (Jev missing or failed) → main line, never a dialog', () => {
    expect(decide(null, T)).toEqual({ kind: 'main' })
  })

  test('the threshold comes from config', () => {
    expect(decide(v('main_task', 0.7), { route: 0.8, followup: 0.6 })).toEqual({ kind: 'ask', why: 'low-confidence' })
  })
})

describe('the dialog', () => {
  test('the question carries Jev’s call and confidence', () => {
    expect(askPrompt(v('sidebar_knowledge', 0.963), { activeTitle: null, followupThreshold: 0.6 }).question).toBe('這句要怎麼處理？(Jev：知識旁問 96%)')
    expect(askPrompt(v('main_task', 0.318), { activeTitle: null, followupThreshold: 0.6 }).question).toBe('這句要怎麼處理？(Jev：主線任務 32%)')
  })

  test('without an active thread: 〔開新的便利貼〕〔送進主線〕', () => {
    const p = askPrompt(v('sidebar_knowledge', 0.9), { activeTitle: null, followupThreshold: 0.6 })
    expect(p.options.map(o => o.label)).toEqual([NEW_NOTE_LABEL, MAIN_LABEL])
  })

  test('with an active thread, is_followup ≥ threshold puts the follow-up first', () => {
    const p = askPrompt(v('sidebar_knowledge', 0.9, { isFollowup: 0.6 }), { activeTitle: 'CRDT無衝突', followupThreshold: 0.6 })
    expect(p.options.map(o => o.label)).toEqual([followupLabel('CRDT無衝突'), NEW_NOTE_LABEL, MAIN_LABEL])
    expect(p.options[0]!.label).toBe('接在「CRDT無衝突」下')
  })

  test('with an active thread, is_followup below threshold puts the new note first', () => {
    const p = askPrompt(v('sidebar_knowledge', 0.9, { isFollowup: 0.59 }), { activeTitle: 'CRDT無衝突', followupThreshold: 0.6 })
    expect(p.options.map(o => o.choice)).toEqual(['new', 'followup', 'main'])
  })

  test('labels map back to choices; free text under "Other" is no choice', () => {
    const p = askPrompt(v('sidebar_knowledge', 0.9, { isFollowup: 1 }), { activeTitle: 'X', followupThreshold: 0.6 })
    expect(choiceOf(p, '接在「X」下')).toBe('followup')
    expect(choiceOf(p, NEW_NOTE_LABEL)).toBe('new')
    expect(choiceOf(p, MAIN_LABEL)).toBe('main')
    expect(choiceOf(p, 'something I typed')).toBeNull()
  })
})

describe('the user’s pick decides', () => {
  test('main or no choice → main line', () => {
    expect(decideFromChoice('main', v('sidebar_knowledge', 0.9), 2)).toEqual({ kind: 'main' })
    expect(decideFromChoice(null, v('sidebar_knowledge', 0.9), 2)).toEqual({ kind: 'main' })
  })

  test('new / followup → a note; route records the pick and Jev’s confidence (source ask)', () => {
    expect(decideFromChoice('new', v('main_task', 0.42), 2)).toMatchObject({
      kind: 'sidebar',
      attach: 'root',
      route: { label: 'new', confidence: 0.42, source: 'ask' },
    })
    expect(decideFromChoice('followup', v('sidebar_knowledge', 0.9), 2)).toMatchObject({ kind: 'sidebar', attach: 'followup', route: { label: 'followup' } })
  })

  test('needs_project_ctx ≥ 0.3 picks the fork; below, the summary provider', () => {
    expect(NEEDS_CTX_AT).toBe(0.3)
    expect(decideFromChoice('new', v('sidebar_knowledge', 0.9, { needsProjectCtx: 0.3 }), 2)).toMatchObject({ answerer: 'fork' })
    expect(decideFromChoice('new', v('sidebar_knowledge', 0.9, { needsProjectCtx: 0.29 }), 2)).toMatchObject({ answerer: 'summary-provider' })
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
