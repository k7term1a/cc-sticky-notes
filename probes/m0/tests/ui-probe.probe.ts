// Named .probe.ts so the main mod's `claude plugin test .` (which runs every *.test.ts
// under the repo) skips it. To run: copy to ui-probe.test.ts, `claude plugin test probes/m0`, delete the copy.
import { expect, test } from 'claude-code/testing'

const user = (text: string) => ({ text, origin: { kind: 'composer' }, isExpanded: false } as never)

test('UserMessage badge keeps the original row', async ($, on) => {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'ORIGINAL ' + (e.props as { text: string }).text) as never
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cc-sticky-probe', surface, component: 'UserMessage', props: user('badge-me please') })
    expect(await ui.find({ type: 'Text', text: /ORIGINAL badge-me/ })).toBeDefined()
    expect(await ui.find({ key: 'badge' })).toBeDefined()
    await ui.press({ key: 'badge' })
    await ui.unmount()
  }
})

test('a hotkey outside one digit / lowercase letter is refused', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, 'ENGINE') as never })
  const ui = await $.ui.mount({ plugin: 'cc-sticky-probe', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { top: 0, bodyRows: 6, contentRows: 1 }, view: {} } as never })
  const alt = await ui.find({ key: 'alt' })
  const engine = await ui.find({ type: 'Text', text: /ENGINE/ })
  // Measured 2026-10-07: plugin tree drawn=false, engine fallback drawn=true
  expect(alt).toBeUndefined()
  expect(engine).toBeDefined()
  await ui.unmount()
})
