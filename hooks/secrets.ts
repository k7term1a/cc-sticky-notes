// Where the API keys come from (PLAN.md「金鑰」, as revised: no machine-wide
// environment variables required). First hit wins:
//   1. the process environment (a terminal, CI)
//   2. ~/.claude/sticky-notes/.env   — per user, outside every repo
//   3. <plugin root>/.env            — a development checkout (git-ignored)
// The current project's own .env is never read: it often holds that app's own
// OPENAI_API_KEY. Values are never logged or stored.

export type KeyName = 'TYPESAFE_API_KEY' | 'OPENAI_API_KEY'

/** KEY=value lines; tolerates a BOM, CRLF, `export `, quotes and comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw)
    if (!m) continue
    let v = m[2] ?? ''
    const q = /^(['"])([\s\S]*)\1$/.exec(v)
    if (q) v = q[2] ?? ''
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]!] = v
  }
  return out
}

/** The key files, in the order they are tried. `home` is USERPROFILE / HOME. */
export function keyFiles(home: string | undefined, pluginRoot: string): string[] {
  const sep = pluginRoot.includes('\\') ? '\\' : '/'
  const files: string[] = []
  if (home) files.push([home.replace(/[\\/]+$/, ''), '.claude', 'sticky-notes', '.env'].join(sep))
  files.push(`${pluginRoot.replace(/[\\/]+$/, '')}${sep}.env`)
  return files
}

/** Where a key was found: 'env', a file path, or null when nowhere. */
export type KeySource = { value: string; from: string } | null

/** First non-empty value: the environment, then each file in order. */
export async function findKey(
  name: KeyName,
  fromEnv: string | undefined,
  files: readonly string[],
  read: (path: string) => Promise<string>,
): Promise<KeySource> {
  if (fromEnv && fromEnv.trim() !== '') return { value: fromEnv.trim(), from: 'env' }
  for (const f of files) {
    let text: string
    try {
      text = await read(f)
    } catch {
      continue // missing or unreadable: try the next one
    }
    const v = parseDotenv(text)[name]
    if (v && v.trim() !== '') return { value: v.trim(), from: f }
  }
  return null
}

export async function resolveKey(...args: Parameters<typeof findKey>): Promise<string | undefined> {
  return (await findKey(...args))?.value
}

/** /sticky-note doctor: where each key comes from, never its value. */
export function describeKey(name: KeyName, found: KeySource): string {
  if (found === null) return `${name}：找不到（環境變數與 key 檔都沒有）`
  return `${name}：有（${found.from === 'env' ? '環境變數' : found.from}）`
}
