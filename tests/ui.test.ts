// UI: the band and the pane draw valid trees on terminal and desktop, follow-ups
// are listed under their parent, and a click shows the whole thread.
import { expect, mock, test } from 'claude-code/testing'

import type { TreeNode } from '../types'

const PLUGIN = 'cc-sticky-notes'
const ROOT = '/proj'

const node = (id: string, parentId: string | null, at: number, title: string, answer: string, summary: string | null = null): TreeNode => ({
  id,
  parentId,
  outlineId: null,
  anchor: { sessionId: 'S1', turnId: null, messageId: null, at, mainSnippet: '' },
  question: `${title}?`,
  answer,
  answeredBy: 'claude-fork',
  title,
  summary,
  tags: [],
  route: { label: 'sidebar_knowledge', confidence: 1, source: 'jev' },
  promotedAt: null,
  promotedIn: null,
  children: [],
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { top: 0, bodyRows: 6, contentRows: 1 }, view: {} } as never,
} as const

const PANE = {
  component: 'Pane',
  requestId: 'sticky',
  props: { title: 'Sticky Notes', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 40, contentRows: 1 }, view: {} } as never,
} as const

test('empty: band and pane skeletons validate on terminal and desktop', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /Sticky Notes/ })).toBeDefined()
    expect(await band.find({ key: 'open' })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /還沒有/ })).toBeDefined()
    await pane.unmount()
  }
})

test('a tree: follow-ups are listed under their parent and a click shows the thread', async ($, on) => {
  mock.store(on, {
    [`node:${ROOT}:r1`]: node('r1', null, 1, '樹載入原因', '因為 $.store 一次只讀一個 key。', '一次只能讀一個 key。'),
    [`node:${ROOT}:c1`]: node('c1', 'r1', 2, '為何全讀', '因為 roots 與 children 是推出來的。'),
    [`node:${ROOT}:r2`]: node('r2', null, 3, 'TCP 背壓', '接收窗口。'),
  })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let forked = ''
  const forks: string[] = []
  on('model.fork', ($, e) => {
    forked = e.prompt
    forks.push(e.prompt.slice(-30))
    return { value: { isAnswered: true, text: 'fork answer', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"title":"新追問","summary":"s"}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    const child = await pane.find({ key: 'node:c1' })
    expect(child).toBeDefined()
    expect(JSON.stringify(child)).toContain('└')
    expect(await pane.find({ key: 'node:r2' })).toBeDefined()

    await pane.press({ key: 'node:c1' })
    // the card: earlier step compact, the question, the full answer
    expect(await pane.find({ type: 'Text', text: /樹載入原因 — 一次只能讀一個 key/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Q 為何全讀\?/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /追問第 2 層/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /在主輸入框直接打字＝追問「為何全讀」/ })).toBeDefined()
    await pane.unmount()
  }

  // the follow-up box: a child of the selected node, then that child is selected
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  await pane.input({ key: 'followup', text: '那 children 什麼時候算？' })
  await clock.advance(10) // the answer runs in $.clock.after(0)
  // the new note is selected: its card shows its question
  expect(await pane.find({ type: 'Text', text: /Q 那 children 什麼時候算？/ })).toBeDefined()
  await pane.unmount()
  await clock.advance(1000)
  expect(forks).toHaveLength(1)
  // the answer and its title arrived
  expect(await (async () => { const p = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE }); const t = await p.find({ type: 'Text', text: /^新追問$/ }); await p.unmount(); return t })()).toBeDefined()
  expect(forked).toContain('[side thread so far]')
  expect(forked).toContain('Q2: 為何全讀?')
  expect(forked).toContain('[question]\n那 children 什麼時候算？')
})
