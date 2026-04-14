/**
 * Thin wrapper around `osascript` for running AppleScript from Node.
 *
 * All functions here shell out to `/usr/bin/osascript -e <script>`. They
 * return the captured stdout or throw with stderr on failure.
 *
 * Security note: inputs are passed as argv to `execFile`, not via shell, so
 * there's no shell injection. AppleScript string escaping is handled by
 * `asString()` which double-quotes the value and escapes embedded quotes +
 * backslashes. Callers should prefer `asString()` over string concatenation.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const OSASCRIPT = '/usr/bin/osascript'
const DEFAULT_TIMEOUT_MS = 15_000

export interface AppleScriptOptions {
  /** Milliseconds before the script is terminated. Default 15s. */
  timeoutMs?: number
}

/**
 * Escape a JavaScript string for safe embedding in an AppleScript `"..."` literal.
 * Wraps the result in double quotes.
 */
export function asString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

/** Run an AppleScript snippet. Returns trimmed stdout. */
export async function runAppleScript(
  script: string,
  options: AppleScriptOptions = {},
): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options
  try {
    const { stdout } = await execFileAsync(OSASCRIPT, ['-e', script], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    const stderr = (error.stderr || '').trim()
    const message = stderr || error.message || 'osascript failed'
    throw new Error(message)
  }
}
