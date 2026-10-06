// UI skeleton: the band and the pane draw valid trees on terminal and desktop.
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'cc-sticky-notes'

test('band and pane skeletons validate on terminal and desktop', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: '/proj' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 6,
        bodyColumns: 80,
        scroll: { top: 0, bodyRows: 6, contentRows: 1 },
        view: {},
      } as never,
    })
    expect(await band.find({ type: 'Text', text: /Sticky Notes/ })).toBeDefined()
    expect(await band.find({ key: 'open' })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'sticky',
      props: { title: 'Sticky Notes', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 20, contentRows: 1 }, view: {} } as never,
    })
    expect(await pane.find({ type: 'Text', text: /還沒有便利貼/ })).toBeDefined()
    expect(await pane.find({ key: 'back' })).toBeDefined()
    await pane.unmount()
  }
})
