// What the logic modules may do outside themselves.
//
// The engine's loader refuses `$` passed into a function imported from another
// file ("$ is followed only into a function declared in this same file, never
// across an import", PROBE.md). So register.ts builds these closures over its
// hook's `$` (portsOf) and hands them down; nothing below register.ts sees `$`.
import type { HttpInit, HttpResponse, ModelCompleteRequest, ModelCompleteResult, ModelForkResult, SessionMessage } from 'claude-code'

import type { Tree } from '../types'

export type KV = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type Ports = {
  sessionId(): Promise<string>
  /** The project key: $.session.repo()?.root ?? $.session.root() (shared across worktrees). */
  projectRoot(): Promise<string>
  turns(): Promise<number>
  messages(): Promise<readonly SessionMessage[]>
  now(): Promise<number>
  /** Runs fn outside the current dispatch ($.clock.after(0, fn)). */
  later(fn: () => void): void
  /** Resolves after ms ($.clock.sleep). */
  sleep(ms: number): Promise<void>
  store: KV
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  fork(prompt: string): Promise<ModelForkResult>
  complete(request: ModelCompleteRequest): Promise<ModelCompleteResult>
  /** Env vars are read with string literals in register.ts; only their values cross. */
  keys: {
    typesafe(): Promise<string | undefined>
    openai(): Promise<string | undefined>
    /** One line per key: found or not, and where; never the value. */
    report(): Promise<string[]>
  }
  ui: {
    log(text: string, to?: 'transcript' | 'debug'): void
    toast(text: string): void
    /** Rejects when dismissed or headless. */
    ask(question: string, options: readonly string[], header: string): Promise<string>
    openPane(): Promise<void>
    closePane(): Promise<void>
    isPaneOpen(): Promise<boolean>
    /** The plugin's one status line under the prompt; undefined clears it. */
    status(text: string | undefined): void
  }
  state: {
    publishTree(tree: Tree): Promise<void>
    lastTurnId(): Promise<string | null>
    turnsAtLastSidebar(): Promise<number>
    setTurnsAtLastSidebar(n: number): Promise<void>
    addPending(delta: number): Promise<void>
    addUnread(delta: number): Promise<void>
    lastPromptUuid(): Promise<string | null>
    lastSampleId(): Promise<string | null>
    setLastSampleId(id: string | null): Promise<void>
    /** The node the pane shows. */
    setSelected(id: string | null): Promise<void>
    selected(): Promise<string | null>
    /** The digest or the project context changed in the store: the pane draws them again. */
    contextChanged(): Promise<void>
    /** R4: a digest run started (`result` null) or ended with `result`, shown on the context card. */
    setDigestStatus(running: boolean, result: string | null): Promise<void>
    /** R7: the prompt that said a rule was broken, shown on the reminder card; null once answered. */
    setReminder(reminder: { prompt: string; at: number } | null): Promise<void>
  }
  /**
   * This plugin's own userConfig field, as the plugin settings show it: written to
   * settings.json (pluginConfigs) through $.config.set; `deny` when the engine refused.
   */
  setOption(field: 'summaryProvider' | 'digestEvery' | 'notionDataSource' | 'askTimeout' | 'routing' | 'notionSync' | 'autoOpenPane' | 'ruleReminder', value: string | number | boolean): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Where this runs, for the Notion rows: the repo's git remote, and the computer's name. */
  place(): Promise<{ remote: string | null; machine: string }>
  /** MCP servers the session has (the claude.ai connectors among them), by their tools' names. */
  mcp: {
    tools(): Promise<string[]>
    call(server: string, tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: { type: string; text?: string }[] }>
  }
}
