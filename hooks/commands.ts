// /sticky-note and its subcommands.
// A command's `{ text }` is a transcript row the model also reads, so anything
// long or private goes to $.ui.log / toast instead and the command returns {}.
import type { CommandRunResult } from 'claude-code'

import { calibrate, formatCalibration, listSamples, parseFeedback } from './feedback'
import { change, dropReason, giveFeedback, projectKey, startNote, type Options } from './notes'
import type { Ports } from './ports'
import { setActive } from './tree'

export const COMMAND = 'sticky-note'

export const COMMAND_SPEC = {
  name: COMMAND,
  description: 'Sticky Notes: open/close the pane, or new | back | feedback | calibrate | doctor | promote | outline | refresh | digest | export | mode | stats',
  argumentHint: '[new <問題> | back | feedback good|bad [main|sidebar|followup|project] | calibrate]',
}

/**
 * /sn: the keyboard way to the pane. The status line cannot be clicked, a plugin
 * button's hotkey works only while its site has the focus, and keybindings.json
 * has no "run a command" action (PROBE.md), so a two-letter command is the shortcut.
 * Takes the same subcommands as /sticky-note.
 */
export const SHORT_COMMAND = 'sn'

export const SHORT_COMMAND_SPEC = {
  name: SHORT_COMMAND,
  description: 'Sticky Notes: open/close the pane (short for /sticky-note)',
  argumentHint: '[new <問題> | back | …]',
}

const LATER: Record<string, string> = {
  promote: 'M2',
  outline: 'M3',
  refresh: 'M3',
  digest: 'M3',
  export: 'M3',
  mode: 'M4',
  stats: 'M4',
}

export function parseArgs(args: string): { sub: string; rest: string } {
  const m = /^\s*(\S*)\s*([\s\S]*)$/.exec(args)
  return { sub: (m?.[1] ?? '').toLowerCase(), rest: (m?.[2] ?? '').trim() }
}

/** The args a /sticky-note new record keeps in the transcript (PROBE.md P10). */
export const NEW_ARGS_MASK = 'new (sticky note)'

/**
 * Rewrites the transcript record of `/sticky-note new <問題>` so the question
 * does not stay in the main context. Returns null when the text is not that record.
 */
export function maskNewArgs(text: string): string | null {
  if (!text.includes(`<command-name>/${COMMAND}</command-name>`) && !text.includes(`<command-name>/${SHORT_COMMAND}</command-name>`)) return null
  const re = /<command-args>\s*new\b[\s\S]*?<\/command-args>/
  return re.test(text) ? text.replace(re, `<command-args>${NEW_ARGS_MASK}</command-args>`) : null
}

export async function runCommand(p: Ports, opts: Options, args: string): Promise<CommandRunResult> {
  const { sub, rest } = parseArgs(args)
  switch (sub) {
    case '': {
      if (await p.ui.isPaneOpen()) await p.ui.closePane()
      else await p.ui.openPane()
      return {}
    }
    case 'new': {
      if (rest === '') return { text: '用法：/sticky-note new <問題>' }
      await startNote(p, opts, {
        question: rest,
        attach: { kind: 'root' },
        answerer: 'fork',
        route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
      })
      p.ui.toast(dropReason(rest))
      return {}
    }
    case 'back': {
      const sessionId = await p.sessionId()
      await change(p, t => setActive(t, sessionId, null))
      return {}
    }
    case 'feedback': {
      const fb = parseFeedback(rest)
      if (fb === null) return { text: '用法：/sticky-note feedback good|bad [main|sidebar|followup|project]' }
      const ok = await giveFeedback(p, { ...fb, source: 'command' })
      p.ui.toast(ok ? `已記下：上一句分類${fb.verdict === 'right' ? '正確' : '錯誤'}${fb.expected ? `，應為 ${fb.expected}` : ''}` : '這個 session 還沒有可以回饋的分類')
      return {}
    }
    case 'doctor': {
      for (const line of await p.keys.report()) p.ui.log(line)
      return {}
    }
    case 'calibrate': {
      const lines = formatCalibration(calibrate(await listSamples(p.store, await projectKey(p))))
      for (const line of lines) p.ui.log(line)
      return {}
    }
    default: {
      const when = LATER[sub]
      return { text: when ? `/sticky-note ${sub}：尚未實作（${when}）` : `未知的子指令：${sub}` }
    }
  }
}
