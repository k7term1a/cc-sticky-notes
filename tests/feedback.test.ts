import { describe, expect, test } from 'claude-code/testing'

import type { AskChoice, FeedbackRecord } from '../types'
import { maskNewArgs, NEW_ARGS_MASK } from '../hooks/commands'
import { calibrate, formatCalibration, listRecords, parseFeedback, RECORD_CAP, recordId, saveRecord, setChoice } from '../hooks/feedback'
import type { KV } from '../hooks/ports'
import { describeKey, findKey, keyFiles, parseDotenv, resolveKey } from '../hooks/secrets'

const memKV = (): KV & { size: () => number } => {
  const mem = new Map<string, string>()
  return {
    size: () => mem.size,
    get: async k => (mem.has(k) ? JSON.parse(mem.get(k)!) : undefined),
    set: async (k, v) => void mem.set(k, JSON.stringify(v)),
    delete: async k => void mem.delete(k),
    keys: async () => [...mem.keys()],
  }
}

const record = (i: number, route: string, confidence: number, choice: AskChoice | null): FeedbackRecord => ({
  id: recordId(1000 + i, `r${i}`),
  at: 1000 + i,
  sessionId: 'S',
  prompt: `p${i}`,
  jev: { route, confidence, isFollowup: 0, needsProjectCtx: 0, tag: null },
  thresholds: { route: 0.6, followup: 0.6, needsCtx: 0.3 },
  asked: route !== 'main_task' || confidence < 0.6,
  outcome: choice ?? 'main',
  choice,
  choiceSource: choice === null ? null : 'ask',
  nodeId: null,
})

describe('feedback records', () => {
  test('/sn feedback: main | new | followup (or 主線 / 便利貼 / 追問), or good', () => {
    expect(parseFeedback('main')).toEqual({ choice: 'main' })
    expect(parseFeedback('new')).toEqual({ choice: 'new' })
    expect(parseFeedback('追問')).toEqual({ choice: 'followup' })
    expect(parseFeedback('便利貼')).toEqual({ choice: 'new' })
    expect(parseFeedback('good')).toEqual({ good: true })
    expect(parseFeedback('nonsense')).toBeNull()
    expect(parseFeedback('')).toBeNull()
  })

  test('ids sort by time; keys are feedback:<root>:<id>; at most RECORD_CAP per project', async () => {
    expect(recordId(5, 'a') < recordId(40, 'a')).toBe(true)
    const kv = memKV()
    for (let i = 0; i < RECORD_CAP + 3; i++) await saveRecord(kv, '/p', record(i, 'main_task', 1, null))
    await saveRecord(kv, '/other', record(0, 'main_task', 1, null))
    const kept = await listRecords(kv, '/p')
    expect(kept).toHaveLength(RECORD_CAP)
    expect(kept[0]?.prompt).toBe('p3')
    expect(await listRecords(kv, '/other')).toHaveLength(1)
    expect((await kv.keys()).every(k => k.startsWith('feedback:'))).toBe(true)
  })

  test('setChoice records a later /sn feedback', async () => {
    const kv = memKV()
    const r = record(1, 'main_task', 0.9, null)
    await saveRecord(kv, '/p', r)
    expect(await setChoice(kv, '/p', r.id, 'new')).toMatchObject({ choice: 'new', choiceSource: 'command' })
    expect(await setChoice(kv, '/p', 'missing', 'new')).toBeNull()
  })

  test('calibrate: what each main-line threshold would let through unasked, and how often it is right', () => {
    const records = [
      record(1, 'sidebar_knowledge', 0.95, 'new'), // always asked
      record(2, 'main_task', 0.99, 'main'),
      record(3, 'main_task', 0.65, 'new'), // Jev said main, the user wanted a note
      record(4, 'main_task', 0.55, 'main'),
      record(5, 'main_task', 0.9, null), // no choice: left out
    ]
    const c = calibrate(records, [0.5, 0.6, 0.7])
    expect(c.labeled).toBe(4)
    expect(c.rows).toEqual([
      { threshold: 0.5, auto: 3, correct: 2, accuracy: 2 / 3, askRate: 0.25 },
      { threshold: 0.6, auto: 2, correct: 1, accuracy: 0.5, askRate: 0.5 },
      { threshold: 0.7, auto: 1, correct: 1, accuracy: 1, askRate: 0.75 },
    ])
    expect(formatCalibration(c)[0]).toBe('路由校正：4 筆有你的選擇')
  })
})

describe('P10: /sticky-note new leaves no question in the transcript', () => {
  const record = '<command-name>/sticky-note</command-name>\n            <command-message>sticky-note</command-message>\n            <command-args>new TCP 的 backpressure 是什麼原理？</command-args>'

  test('masks the args of new, leaves everything else', () => {
    expect(maskNewArgs(record)).toBe(record.replace('new TCP 的 backpressure 是什麼原理？', NEW_ARGS_MASK))
    expect(maskNewArgs(record.replace('new TCP', 'back TCP'))).toBeNull()
    expect(maskNewArgs(record.replace('/sticky-note</command-name>', '/other</command-name>'))).toBeNull()
  })
})

describe('keys from files (no machine-wide env vars needed)', () => {
  test('parseDotenv: BOM, CRLF, quotes, export, comments', () => {
    expect(parseDotenv('\uFEFFTYPESAFE_API_KEY="apikey_x"\r\nexport OPENAI_API_KEY=sk-y # mine\r\n# c\r\n')).toEqual({ TYPESAFE_API_KEY: 'apikey_x', OPENAI_API_KEY: 'sk-y' })
  })

  test('order: environment, then ~/.claude/sticky-notes/.env, then the plugin folder', async () => {
    const files = keyFiles('C:\\Users\\me', 'C:\\dev\\cc-sticky-notes')
    expect(files).toEqual(['C:\\Users\\me\\.claude\\sticky-notes\\.env', 'C:\\dev\\cc-sticky-notes\\.env'])
    const disk: Record<string, string> = { [files[1]!]: 'OPENAI_API_KEY=from-plugin\nTYPESAFE_API_KEY=ts-plugin', [files[0]!]: 'OPENAI_API_KEY=from-home' }
    const read = async (p: string) => {
      if (!(p in disk)) throw new Error('ENOENT')
      return disk[p]!
    }
    expect(await resolveKey('OPENAI_API_KEY', 'from-env', files, read)).toBe('from-env')
    expect(await resolveKey('OPENAI_API_KEY', undefined, files, read)).toBe('from-home')
    expect(await resolveKey('TYPESAFE_API_KEY', '', files, read)).toBe('ts-plugin')
    expect(describeKey('OPENAI_API_KEY', await findKey('OPENAI_API_KEY', undefined, files, read))).toBe(`OPENAI_API_KEY：有（${files[0]}）`)
    delete disk[files[1]!]
    expect(await resolveKey('TYPESAFE_API_KEY', undefined, files, read)).toBeUndefined()
    expect(describeKey('TYPESAFE_API_KEY', null)).toContain('找不到')
  })
})
