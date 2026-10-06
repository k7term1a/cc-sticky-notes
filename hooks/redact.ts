// openaiContextMode=redacted stripping rules (PLAN.md「openaiContextMode」).
// Not a guarantee: names, architecture and business logic still go out.

export const REDACTED = '[redacted]'

const FENCE = /(```|~~~)[\s\S]*?(?:\1|$)/g
/** .env style KEY=value (uppercase key), value up to whitespace. */
const ENV_ASSIGN = /\b[A-Z][A-Z0-9_]{1,}\s*=\s*\S+/g
/** A token containing / or \ and ending in an extension. */
const PATHLIKE = /[^\s"'`()<>[\]{}]*[\\/][^\s"'`()<>[\]{}]*\.[A-Za-z0-9]{1,8}\b/g
/** 20+ consecutive ASCII letters/digits (suspected keys, hashes). */
const LONG_RUN = /[A-Za-z0-9]{20,}/g

export function redact(text: string): string {
  return text
    .replace(FENCE, REDACTED)
    .replace(ENV_ASSIGN, REDACTED)
    .replace(PATHLIKE, REDACTED)
    .replace(LONG_RUN, REDACTED)
}
