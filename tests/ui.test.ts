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

const PANE = {
  component: 'Pane',
  requestId: 'sticky',
  props: { title: 'Sticky Notes', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 40, contentRows: 1 }, view: {} } as never,
} as const

test('empty: the pane validates on terminal and desktop', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /還沒有/ })).toBeDefined()
    await pane.unmount()
  }
})

test('cards: one per topic; a press opens the thread; picks, reply and rewrite; the tag as a chip', async ($, on) => {
  mock.store(on, {
    [`node:${ROOT}:r1`]: (() => { const n = node('r1', null, 1, '樹載入原因', '因為 $.store 一次只讀一個 key。', '一次只能讀一個 key。'); return { ...n, route: { ...n.route, jev: 'sidebar_knowledge' } } })(),
    [`node:${ROOT}:c1`]: node('c1', 'r1', 2, '為何全讀', '因為 roots 與 children 是推出來的。'),
    [`node:${ROOT}:c3`]: node('c3', 'r1', 4, '一個 JSON', '同時寫會互相蓋掉。'),
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
    // closed cards, one per topic; no question drawn yet
    expect(await pane.find({ key: 'open:r1' })).toBeDefined()
    expect(await pane.find({ key: 'open:r2' })).toBeDefined()
    expect(await pane.find({ key: 'q:r1' })).toBeUndefined()
    // the tag before the time; the time opens the card too
    expect(await pane.find({ type: 'Text', text: surface === 'terminal' ? /^\[知識旁問\]$/ : /^ 知識旁問 $/ })).toBeDefined()
    expect(await pane.find({ key: 'open-meta:r1' })).toBeDefined()
    // open: the thread runs on down by the newest follow-up (c3), with both offered as picks
    await pane.press({ key: 'open:r1' })
    expect(await pane.find({ key: 'q:r1' })).toBeDefined()
    expect(await pane.find({ key: 'q:c3' })).toBeDefined()
    expect(await pane.find({ key: 'pick:c1' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Q / })).toBeUndefined() // no Q/A words
    await pane.press({ key: 'pick:c1' })
    expect(await pane.find({ key: 'q:c1' })).toBeDefined()
    expect(await pane.find({ key: 'q:c3' })).toBeUndefined()
    expect(await pane.find({ key: 'reply:c1' })).toBeDefined()
    await pane.press({ key: 'close:r1' })
    expect(await pane.find({ key: 'q:r1' })).toBeUndefined()
    await pane.unmount()
  }

  // the reply box: a follow-up of the last note shown, which then is the one followed up
  let pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  await pane.press({ key: 'open:r1' })
  await pane.press({ key: 'pick:c1' })
  await pane.input({ key: 'reply:c1', text: '那 children 什麼時候算？' })
  await clock.advance(10) // the answer runs in $.clock.after(0)
  expect(await pane.find({ type: 'Text', text: /^那 children 什麼時候算？$/ })).toBeDefined()
  expect(await pane.find({ key: 'reply:c1' })).toBeUndefined() // a fresh, empty box under the new note
  await pane.unmount()
  await clock.advance(1000)
  expect(forks).toHaveLength(1)
  expect(forked).toContain('[side thread so far]')
  expect(forked).toContain('Q2: 為何全讀?')
  expect(forked).toContain('[question]\n那 children 什麼時候算？')

  // ✎ (always drawn on the terminal): asked again beside the old question, under the same parent
  // (the card is still open on the reply's thread, which runs through c1)
  const term = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await term.press({ key: 'edit:c1' })
  await term.input({ key: 'edit-box:c1', text: '換個問法：為什麼要全讀？' })
  await clock.advance(10)
  expect(await term.find({ key: 'edit-box:c1' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /^換個問法：為什麼要全讀？$/ })).toBeDefined()
  await term.unmount()
  await clock.advance(1000)
  expect(forks).toHaveLength(2)
  expect(forked).not.toContain('Q2: 為何全讀?') // a sibling of c1: c1 is not in its history
})

test('/sn opens and closes the pane like /sticky-note', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  const open: string[] = []
  let isOpen = false
  on('ui.open', ($, e) => {
    open.push(e.id)
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'sticky', title: 'Sticky Notes', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  await $.command.run({ command: 'sn', args: '' } as never)
  expect(open).toEqual(['sticky'])
  expect(isOpen).toBe(true)
  await $.command.run({ command: 'sn', args: '' } as never)
  expect(isOpen).toBe(false)
})

test('a pasted 12,000-character question and a 15,000-character answer still draw (Text / Markdown hold 10,000)', async ($, on) => {
  const longQ = '貼上的內容'.repeat(2400) // 12,000 characters
  const longA = '很長的答案。'.repeat(2500) // 15,000 characters
  mock.store(on, { [`node:${ROOT}:big`]: { ...node('big', null, 1, '長問題', longA), question: longQ } })
  mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    await pane.press({ key: 'open:big' })
    expect(await pane.find({ type: 'Text', text: /（共 12000 字）/ })).toBeDefined()
    expect(await pane.find({ key: 'close:big' })).toBeDefined() // the engine did not draw its own instead
    await pane.press({ key: 'close:big' }) // the selection outlives the mount
    await pane.unmount()
  }
})

test('R4: the project context card shows the digest and edits the facts', async ($, on) => {
  mock.store(on, {
    [`digest:${ROOT}:S1`]: { text: '主線在把 auth 改成 session cookie。', turns: 3, at: 1 },
    [`context:${ROOT}`]: [{ id: 'f1', text: '我們用 session cookie，不用 JWT', at: 1, sessionId: 'S1', source: 'auto' }],
  })
  mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Button', text: /專案脈絡　1 條/ } as never)).toBeDefined()
  await pane.press({ key: 'open:context' })
  expect(await pane.find({ type: 'Text', text: /^主線在把 auth 改成 session cookie。$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /每 3 回合背景統整 · Claude/ })).toBeDefined()
  await pane.input({ key: 'fact-add:1', text: '部署前先跑 migration' })
  expect(await pane.find({ type: 'Text', text: /^2\. 部署前先跑 migration（手動）$/ })).toBeDefined()
  await pane.press({ key: 'fact-rm:f1' })
  expect(await pane.find({ type: 'Text', text: /^1\. 部署前先跑 migration（手動）$/ })).toBeDefined()
  await pane.unmount()
})
