/**
 * Native macOS MCP tools.
 *
 * These use `osascript` (AppleScript) to drive any macOS application: click
 * at coordinates, type text, press key combos, focus an app, list windows,
 * read visible text via the Accessibility API. A generic escape hatch lets
 * the agent run arbitrary AppleScript.
 *
 * macOS will prompt the user on first use to grant Accessibility + Automation
 * permissions to the process running the MCP server (usually Node). The
 * tools return clear errors pointing at System Settings when permission is
 * denied.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { asString, runAppleScript } from './applescript.js'

const PLATFORM_ERROR =
  'This tool is only available on macOS. The MCP server is running on a different platform.'

function isMacOS(): boolean {
  return process.platform === 'darwin'
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * Map human-friendly modifier names to AppleScript "key code ... using" clauses.
 * Supports: cmd/command, ctrl/control, opt/option/alt, shift, fn.
 */
const MODIFIER_MAP: Record<string, string> = {
  cmd: 'command down',
  command: 'command down',
  ctrl: 'control down',
  control: 'control down',
  opt: 'option down',
  option: 'option down',
  alt: 'option down',
  shift: 'shift down',
}

/**
 * Convert a key spec like "cmd+c" or "shift+tab" into an AppleScript
 * `keystroke`/`key code` command. Single characters use keystroke; named
 * keys (tab, escape, return, arrow keys, fn keys) use key code.
 */
function buildKeystrokeCommand(keys: string): string {
  const parts = keys.split('+').map((p) => p.trim().toLowerCase())
  const modifiers: string[] = []
  let key = ''

  for (const part of parts) {
    if (MODIFIER_MAP[part]) {
      modifiers.push(MODIFIER_MAP[part]!)
    } else {
      key = part
    }
  }

  if (!key) {
    throw new Error(`No key specified in "${keys}". Expected something like "cmd+c" or "return".`)
  }

  const using = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : ''

  // Named keys → key code
  const NAMED_KEYS: Record<string, number> = {
    return: 36,
    enter: 76,
    tab: 48,
    space: 49,
    delete: 51,
    backspace: 51,
    escape: 53,
    esc: 53,
    left: 123,
    right: 124,
    down: 125,
    up: 126,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
  }

  if (NAMED_KEYS[key] != null) {
    return `key code ${NAMED_KEYS[key]}${using}`
  }

  if (key.length === 1) {
    return `keystroke ${asString(key)}${using}`
  }

  throw new Error(
    `Unrecognized key "${key}". Use single characters (e.g. "c") or named keys (e.g. "tab", "return", "escape", "f1").`,
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_click — click at screen coordinates (global)
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopClickTool(server: McpServer) {
  server.tool(
    'desktop_click',
    'Click at absolute screen coordinates on macOS. Use desktop_focus first to bring the target app to the front. Coordinates are in screen points (origin top-left). Requires macOS Accessibility permission for the process running the MCP server.',
    {
      x: z.number().int().describe('X coordinate in screen points'),
      y: z.number().int().describe('Y coordinate in screen points'),
      button: z
        .enum(['left', 'right'])
        .optional()
        .describe('Mouse button to click (default: left).'),
    },
    async ({ x, y, button = 'left' }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // System Events' `click at {x, y}` performs a left-click. For right
      // click we use the `ctrl` modifier (standard macOS convention) or a
      // secondary-click simulation. AppleScript has no native right-click
      // — we emit a ctrl+click which all macOS apps treat as a right click.
      const script =
        button === 'right'
          ? `tell application "System Events" to key down control\n` +
            `tell application "System Events" to click at {${x}, ${y}}\n` +
            `tell application "System Events" to key up control`
          : `tell application "System Events" to click at {${x}, ${y}}`

      try {
        await runAppleScript(script)
        return textResult(`Clicked at (${x}, ${y}) with ${button} button`)
      } catch (err) {
        return textResult(formatError('desktop_click', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_type — type text into the frontmost app
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopTypeTool(server: McpServer) {
  server.tool(
    'desktop_type',
    'Type text into the frontmost macOS application. Use desktop_focus to bring a specific app to the front first. Supports newlines (they will be typed as Return key presses). Text with embedded special characters is typed literally.',
    {
      text: z.string().describe('Text to type. Newlines are typed as Return.'),
      app: z
        .string()
        .optional()
        .describe('Optional app name to focus before typing (e.g. "Safari", "Code").'),
    },
    async ({ text, app }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // Split on \n and emit `keystroke` for each line + `key code 36` (Return) between.
      const lines = text.split('\n')
      const statements: string[] = []

      if (app) {
        statements.push(`tell application ${asString(app)} to activate`)
        statements.push(`delay 0.1`)
      }

      statements.push(`tell application "System Events"`)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (line.length > 0) {
          statements.push(`  keystroke ${asString(line)}`)
        }
        if (i < lines.length - 1) {
          statements.push(`  key code 36`) // Return
        }
      }
      statements.push(`end tell`)

      try {
        await runAppleScript(statements.join('\n'))
        return textResult(`Typed ${text.length} character${text.length === 1 ? '' : 's'}${app ? ` into ${app}` : ''}`)
      } catch (err) {
        return textResult(formatError('desktop_type', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_key — press a key combo (e.g. ⌘C, shift+tab)
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopKeyTool(server: McpServer) {
  server.tool(
    'desktop_key',
    'Press a key combo on the frontmost macOS application. Use "+" to combine modifiers with a key. Modifiers: cmd, ctrl, opt/alt, shift. Named keys: return, tab, space, escape, delete, up/down/left/right, f1-f12. Single-character keys: any letter/digit.',
    {
      keys: z
        .string()
        .describe('Key combo string, e.g. "cmd+c", "cmd+shift+t", "escape", "tab", "return".'),
      app: z
        .string()
        .optional()
        .describe('Optional app name to focus before pressing (e.g. "Safari").'),
    },
    async ({ keys, app }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      let keyCommand: string
      try {
        keyCommand = buildKeystrokeCommand(keys)
      } catch (err) {
        return textResult((err as Error).message)
      }

      const statements: string[] = []
      if (app) {
        statements.push(`tell application ${asString(app)} to activate`)
        statements.push(`delay 0.1`)
      }
      statements.push(`tell application "System Events" to ${keyCommand}`)

      try {
        await runAppleScript(statements.join('\n'))
        return textResult(`Pressed ${keys}${app ? ` in ${app}` : ''}`)
      } catch (err) {
        return textResult(formatError('desktop_key', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_focus — bring an app to the front
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopFocusTool(server: McpServer) {
  server.tool(
    'desktop_focus',
    'Bring a macOS application to the foreground. Launches the app if it is not already running.',
    {
      app: z
        .string()
        .describe('Application name as it appears in /Applications or the Dock (e.g. "Safari", "Code", "Conductor").'),
    },
    async ({ app }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const script = `tell application ${asString(app)} to activate`

      try {
        await runAppleScript(script)
        return textResult(`Focused ${app}`)
      } catch (err) {
        return textResult(formatError('desktop_focus', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_list_windows — list visible windows across all apps
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopListWindowsTool(server: McpServer) {
  server.tool(
    'desktop_list_windows',
    'List visible windows across all running macOS applications. Returns one line per window: "<app> — <window title>". Useful before desktop_focus to confirm the exact app name, or to discover what the user has open.',
    {},
    async () => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // Iterate all processes, grab their windows' names. Skip background-only
      // processes (those with no windows).
      const script = `
set output to ""
tell application "System Events"
  set procList to (every process whose background only is false)
  repeat with p in procList
    try
      set pName to name of p
      set winList to (every window of p)
      repeat with w in winList
        try
          set wName to name of w
          if wName is not missing value and wName is not "" then
            set output to output & pName & " — " & wName & "\n"
          end if
        end try
      end repeat
    end try
  end repeat
end tell
return output
      `.trim()

      try {
        const out = await runAppleScript(script, { timeoutMs: 10_000 })
        if (!out) return textResult('(no visible windows)')
        return textResult(out)
      } catch (err) {
        return textResult(formatError('desktop_list_windows', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_read_window — read visible text in a window via Accessibility
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopReadWindowTool(server: McpServer) {
  server.tool(
    'desktop_read_window',
    'Read the visible text of a macOS application window via the Accessibility API. Returns the window title plus a best-effort text dump of UI elements. Works on most native Cocoa apps; some Electron apps expose little via AX.',
    {
      app: z
        .string()
        .describe('Application name (e.g. "Safari", "Conductor").'),
    },
    async ({ app }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // Recursively collect title/description/value for every UI element in the
      // frontmost window of the target app. Uses `entire contents` for a flat
      // list — fastest way to dump a window's accessibility tree.
      const script = `
tell application ${asString(app)} to activate
delay 0.15
tell application "System Events"
  tell process ${asString(app)}
    try
      set frontWin to front window
    on error
      return "(no front window for ${app.replace(/"/g, '')})"
    end try
    set winTitle to name of frontWin
    set output to "=== " & winTitle & " ===" & linefeed
    set allElems to entire contents of frontWin
    repeat with el in allElems
      try
        set elRole to role of el
        set elName to ""
        try
          set elName to name of el
        end try
        set elValue to ""
        try
          set elValue to value of el as text
        end try
        set elDesc to ""
        try
          set elDesc to description of el
        end try
        set line to elRole
        if elName is not "" and elName is not missing value then set line to line & " name=" & elName
        if elDesc is not "" and elDesc is not missing value then set line to line & " desc=" & elDesc
        if elValue is not "" and elValue is not missing value then set line to line & " value=" & elValue
        set output to output & line & linefeed
      end try
    end repeat
    return output
  end tell
end tell
      `.trim()

      try {
        const out = await runAppleScript(script, { timeoutMs: 20_000 })
        return textResult(out || '(empty)')
      } catch (err) {
        return textResult(formatError('desktop_read_window', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_run_applescript — escape hatch for arbitrary AppleScript
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopRunAppleScriptTool(server: McpServer) {
  server.tool(
    'desktop_run_applescript',
    'Run an arbitrary AppleScript snippet via osascript. Use this as an escape hatch when the higher-level tools do not cover your use case (e.g. complex Finder operations, app-specific AppleScript dictionaries, System Events automation beyond click/type/key). Returns the script\'s stdout. The script runs with the permissions of the MCP server process.',
    {
      script: z.string().describe('AppleScript source code to execute.'),
      timeoutMs: z
        .number()
        .int()
        .optional()
        .describe('Timeout in milliseconds (default 15000, max 60000).'),
    },
    async ({ script, timeoutMs }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const clampedTimeout = timeoutMs != null ? Math.min(Math.max(timeoutMs, 1000), 60_000) : undefined

      try {
        const out = await runAppleScript(script, clampedTimeout != null ? { timeoutMs: clampedTimeout } : {})
        return textResult(out || '(no output)')
      } catch (err) {
        return textResult(formatError('desktop_run_applescript', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// Register all
// ═══════════════════════════════════════════════════════════════════

export function registerAllTools(server: McpServer) {
  registerDesktopClickTool(server)
  registerDesktopTypeTool(server)
  registerDesktopKeyTool(server)
  registerDesktopFocusTool(server)
  registerDesktopListWindowsTool(server)
  registerDesktopReadWindowTool(server)
  registerDesktopRunAppleScriptTool(server)
}

// ─── Internal helpers ─────────────────────────────────────────────

function formatError(tool: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // macOS permission errors mention "-1743" (not authorized) or "-25200"
  if (/-1743|not authorized|not allowed/i.test(message)) {
    return `${tool} failed: ${message}\n\nThis usually means the process running the MCP server needs Accessibility or Automation permission. Open System Settings → Privacy & Security → Accessibility (or Automation) and enable the parent process (Terminal, iTerm, or Node).`
  }
  return `${tool} failed: ${message}`
}
