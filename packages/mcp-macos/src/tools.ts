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

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { asString, runAppleScript } from './applescript.js'

const execFileAsync = promisify(execFile)

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
// desktop_clipboard_get — read the current clipboard text
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopClipboardGetTool(server: McpServer) {
  server.tool(
    'desktop_clipboard_get',
    'Return the current macOS clipboard contents as text. Non-text clipboards (images, files) return an empty string.',
    {},
    async () => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // `pbpaste` is the canonical clipboard reader — more robust than AppleScript's
      // `the clipboard as text` which errors on mixed/non-coercible clipboard types.
      try {
        const { stdout } = await execFileAsync('/usr/bin/pbpaste', [], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
        return textResult(stdout)
      } catch (err) {
        return textResult(formatError('desktop_clipboard_get', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_clipboard_set — overwrite the clipboard with text
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopClipboardSetTool(server: McpServer) {
  server.tool(
    'desktop_clipboard_set',
    'Overwrite the macOS clipboard with the given text. Useful for handing output from the agent to a running app (paste with desktop_key {keys: "cmd+v"}).',
    {
      text: z.string().describe('Text to place on the clipboard.'),
    },
    async ({ text }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // `pbcopy` reads stdin and writes to the clipboard. More robust than
      // AppleScript `set the clipboard to ...` which can interact badly with
      // existing non-text clipboard contents.
      try {
        await new Promise<void>((resolve, reject) => {
          const child = execFile('/usr/bin/pbcopy', [], (err) => (err ? reject(err) : resolve()))
          child.stdin?.write(text)
          child.stdin?.end()
        })
        return textResult(`Set clipboard (${text.length} char${text.length === 1 ? '' : 's'})`)
      } catch (err) {
        return textResult(formatError('desktop_clipboard_set', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_screenshot_region — capture a rectangular region of the screen
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopScreenshotRegionTool(server: McpServer) {
  server.tool(
    'desktop_screenshot_region',
    'Capture a rectangular region of the macOS screen (in screen points, origin top-left). Returns a PNG image. Use this instead of desktop_screenshot when you only want a specific part of the screen (e.g. a single panel or dialog).',
    {
      x: z.number().int().describe('Left edge of the region, in screen points.'),
      y: z.number().int().describe('Top edge of the region, in screen points.'),
      width: z.number().int().positive().describe('Region width in screen points.'),
      height: z.number().int().positive().describe('Region height in screen points.'),
    },
    async ({ x, y, width, height }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const filePath = join(tmpdir(), `desktop-region-${Date.now()}.png`)

      try {
        // `-x` silences the capture sound, `-R x,y,w,h` selects a region without UI.
        await execFileAsync('/usr/sbin/screencapture', [
          '-x',
          '-R',
          `${x},${y},${width},${height}`,
          filePath,
        ])
        const pngBuffer = await readFile(filePath)
        return {
          content: [
            {
              type: 'image' as const,
              data: pngBuffer.toString('base64'),
              mimeType: 'image/png',
            },
            {
              type: 'text' as const,
              text: `Region screenshot saved: ${filePath}`,
            },
          ],
        }
      } catch (err) {
        return textResult(formatError('desktop_screenshot_region', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_menu_click — click a path through the menu bar
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopMenuClickTool(server: McpServer) {
  server.tool(
    'desktop_menu_click',
    'Click a menu-bar item in a macOS app by path, e.g. ["File", "New Tab"]. Works for nested submenus — each path element selects one level. The app is brought to the front first.',
    {
      app: z
        .string()
        .describe('Application name (e.g. "Safari", "Code").'),
      path: z
        .array(z.string())
        .min(1)
        .describe('Ordered menu path, e.g. ["File", "New", "Document"]. First element is the top-level menu title.'),
    },
    async ({ app, path }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // Build nested `menu item ... of menu ...` chain. The innermost element is the
      // terminal menu item we click; outer elements are the menus containing it.
      //
      // For path ["File", "New", "Document"] we generate:
      //   click menu item "Document" of menu "New" of menu item "New" of menu "File" of menu bar item "File" of menu bar 1
      const [top, ...rest] = path
      if (!top) return textResult('desktop_menu_click: path must have at least one element')

      let target = `menu bar item ${asString(top)} of menu bar 1`
      if (rest.length === 0) {
        // Click the top-level menu itself (rare — usually has children)
        const script = `
tell application ${asString(app)} to activate
delay 0.1
tell application "System Events"
  tell process ${asString(app)}
    click ${target}
  end tell
end tell
        `.trim()
        try {
          await runAppleScript(script)
          return textResult(`Clicked ${app} menu: ${path.join(' → ')}`)
        } catch (err) {
          return textResult(formatError('desktop_menu_click', err))
        }
      }

      // Walk through parent menus. For path [top, a, b, c] we need:
      //   menu item "c" of menu "b" of menu item "b" of menu "a" of menu item "a" of menu "top" of menu bar item "top" of menu bar 1
      let chain = `menu ${asString(top)} of ${target}`
      for (let i = 0; i < rest.length - 1; i++) {
        const name = rest[i]!
        chain = `menu ${asString(name)} of menu item ${asString(name)} of ${chain}`
      }
      const leaf = rest[rest.length - 1]!
      const fullTarget = `menu item ${asString(leaf)} of ${chain}`

      const script = `
tell application ${asString(app)} to activate
delay 0.15
tell application "System Events"
  tell process ${asString(app)}
    click ${fullTarget}
  end tell
end tell
      `.trim()

      try {
        await runAppleScript(script)
        return textResult(`Clicked ${app} menu: ${path.join(' → ')}`)
      } catch (err) {
        return textResult(formatError('desktop_menu_click', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_window_move — move the front window of an app
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopWindowMoveTool(server: McpServer) {
  server.tool(
    'desktop_window_move',
    'Move the front window of a macOS app to absolute screen coordinates (origin top-left, in screen points). The app is brought to the front first.',
    {
      app: z.string().describe('Application name (e.g. "Safari").'),
      x: z.number().int().describe('New X position of the window\'s top-left corner.'),
      y: z.number().int().describe('New Y position of the window\'s top-left corner.'),
    },
    async ({ app, x, y }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const script = `
tell application ${asString(app)} to activate
delay 0.1
tell application "System Events"
  tell process ${asString(app)}
    set position of front window to {${x}, ${y}}
  end tell
end tell
      `.trim()

      try {
        await runAppleScript(script)
        return textResult(`Moved ${app} front window to (${x}, ${y})`)
      } catch (err) {
        return textResult(formatError('desktop_window_move', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_window_resize — resize the front window of an app
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopWindowResizeTool(server: McpServer) {
  server.tool(
    'desktop_window_resize',
    'Resize the front window of a macOS app to the given pixel dimensions. The app is brought to the front first. Some apps clamp to a minimum size.',
    {
      app: z.string().describe('Application name.'),
      width: z.number().int().positive().describe('New width in screen points.'),
      height: z.number().int().positive().describe('New height in screen points.'),
    },
    async ({ app, width, height }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const script = `
tell application ${asString(app)} to activate
delay 0.1
tell application "System Events"
  tell process ${asString(app)}
    set size of front window to {${width}, ${height}}
  end tell
end tell
      `.trim()

      try {
        await runAppleScript(script)
        return textResult(`Resized ${app} front window to ${width}x${height}`)
      } catch (err) {
        return textResult(formatError('desktop_window_resize', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_scroll — post a scroll-wheel event at screen coordinates
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopScrollTool(server: McpServer) {
  server.tool(
    'desktop_scroll',
    'Post a scroll-wheel event at absolute screen coordinates. Positive dy scrolls content up (wheel towards user); negative dy scrolls down. Positive dx scrolls right. Uses CGEvent via JavaScript for Automation — requires Accessibility permission.',
    {
      x: z.number().int().describe('X coordinate of the scroll target.'),
      y: z.number().int().describe('Y coordinate of the scroll target.'),
      dy: z.number().int().describe('Vertical pixels to scroll (positive = up, negative = down).'),
      dx: z.number().int().optional().describe('Horizontal pixels to scroll (default 0).'),
    },
    async ({ x, y, dy, dx = 0 }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // JXA lets us reach CoreGraphics without a compiled helper. We move the mouse
      // to (x, y) so that the scroll event hits the right window under the cursor,
      // then post a pixel-unit scroll wheel event.
      const jxa = `
ObjC.import('CoreGraphics');
var moveEvent = $.CGEventCreateMouseEvent(null, 5, { x: ${x}, y: ${y} }, 0);
$.CGEventPost(0, moveEvent);
var scrollEvent = $.CGEventCreateScrollWheelEvent(null, 0, 2, ${dy}, ${dx});
$.CGEventPost(0, scrollEvent);
'ok';
      `.trim()

      try {
        await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], {
          timeout: 5000,
        })
        return textResult(`Scrolled at (${x}, ${y}) by dy=${dy}, dx=${dx}`)
      } catch (err) {
        return textResult(formatError('desktop_scroll', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_app_launch — launch an app by name or bundle ID
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopAppLaunchTool(server: McpServer) {
  server.tool(
    'desktop_app_launch',
    'Launch a macOS application via `open -a`. Unlike desktop_focus, this can launch the app in the background (without activating) and accepts bundle IDs in addition to names. No-op if the app is already running (unless background is false, which re-activates).',
    {
      app: z
        .string()
        .describe('App name (e.g. "Safari") or bundle ID (e.g. "com.apple.Safari").'),
      background: z
        .boolean()
        .optional()
        .describe('Launch without activating (default false). Useful for prepping an app before interacting.'),
      bundleId: z
        .boolean()
        .optional()
        .describe('Set true if `app` is a bundle ID rather than a name.'),
    },
    async ({ app, background = false, bundleId = false }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const args: string[] = []
      if (background) args.push('-g')
      args.push(bundleId ? '-b' : '-a', app)

      try {
        await execFileAsync('/usr/bin/open', args, { timeout: 10_000 })
        return textResult(`Launched ${app}${background ? ' (background)' : ''}`)
      } catch (err) {
        return textResult(formatError('desktop_app_launch', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_app_quit — graceful quit via AppleScript
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopAppQuitTool(server: McpServer) {
  server.tool(
    'desktop_app_quit',
    'Gracefully quit a macOS application. The app is sent a standard quit request — it may show save-changes dialogs for dirty documents, which the user must handle. Does not force-kill.',
    {
      app: z.string().describe('Application name (e.g. "Safari").'),
    },
    async ({ app }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const script = `tell application ${asString(app)} to quit`

      try {
        await runAppleScript(script)
        return textResult(`Sent quit to ${app}`)
      } catch (err) {
        return textResult(formatError('desktop_app_quit', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_frontmost_app — get the currently focused app
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopFrontmostAppTool(server: McpServer) {
  server.tool(
    'desktop_frontmost_app',
    'Return the name of the macOS application currently in the foreground. Useful before desktop_type / desktop_key to confirm the target, or to save/restore focus around a series of actions.',
    {},
    async () => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const script = `tell application "System Events" to return name of first process whose frontmost is true`

      try {
        const out = await runAppleScript(script)
        return textResult(out || '(unknown)')
      } catch (err) {
        return textResult(formatError('desktop_frontmost_app', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_open_url — open a URL in the default browser
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopOpenUrlTool(server: McpServer) {
  server.tool(
    'desktop_open_url',
    'Open a URL in the default macOS browser (or the registered handler for its scheme — e.g. mailto:, slack://). Does not return the page contents.',
    {
      url: z.string().url().describe('URL to open (http(s), mailto:, custom scheme, etc.).'),
    },
    async ({ url }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      try {
        await execFileAsync('/usr/bin/open', [url], { timeout: 10_000 })
        return textResult(`Opened ${url}`)
      } catch (err) {
        return textResult(formatError('desktop_open_url', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_open_path — open a file or folder with its default handler
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopOpenPathTool(server: McpServer) {
  server.tool(
    'desktop_open_path',
    'Open a file or folder with its default macOS handler (Finder for folders, registered app for files). Equivalent to double-clicking it in Finder. Use an absolute path.',
    {
      path: z.string().describe('Absolute filesystem path to a file or folder.'),
      reveal: z
        .boolean()
        .optional()
        .describe('Reveal the item in Finder instead of opening it (default false).'),
    },
    async ({ path, reveal = false }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const args = reveal ? ['-R', path] : [path]

      try {
        await execFileAsync('/usr/bin/open', args, { timeout: 10_000 })
        return textResult(`${reveal ? 'Revealed' : 'Opened'} ${path}`)
      } catch (err) {
        return textResult(formatError('desktop_open_path', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_notification — post a native banner notification
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopNotificationTool(server: McpServer) {
  server.tool(
    'desktop_notification',
    'Post a native macOS banner notification. Great for agent-done signals, long-running task completion, or getting the user\'s attention when the Terminal is not focused.',
    {
      title: z.string().describe('Notification title (bold top line).'),
      message: z.string().describe('Notification body text.'),
      subtitle: z.string().optional().describe('Optional subtitle (appears between title and message).'),
      sound: z
        .string()
        .optional()
        .describe('Optional sound name (e.g. "Glass", "Ping", "Submarine"). See /System/Library/Sounds.'),
    },
    async ({ title, message, subtitle, sound }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      const parts = [`display notification ${asString(message)} with title ${asString(title)}`]
      if (subtitle) parts.push(`subtitle ${asString(subtitle)}`)
      if (sound) parts.push(`sound name ${asString(sound)}`)

      try {
        await runAppleScript(parts.join(' '))
        return textResult(`Posted notification: ${title}`)
      } catch (err) {
        return textResult(formatError('desktop_notification', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_mouse_move — move cursor without clicking (hover)
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopMouseMoveTool(server: McpServer) {
  server.tool(
    'desktop_mouse_move',
    'Move the mouse cursor to absolute screen coordinates without clicking. Useful for triggering hover states (tooltips, hover-reveal UI). Uses CGEvent via JXA — requires Accessibility permission.',
    {
      x: z.number().int().describe('X coordinate in screen points.'),
      y: z.number().int().describe('Y coordinate in screen points.'),
    },
    async ({ x, y }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // Event type 5 = kCGEventMouseMoved
      const jxa = `
ObjC.import('CoreGraphics');
var e = $.CGEventCreateMouseEvent(null, 5, { x: ${x}, y: ${y} }, 0);
$.CGEventPost(0, e);
'ok';
      `.trim()

      try {
        await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 5000 })
        return textResult(`Moved cursor to (${x}, ${y})`)
      } catch (err) {
        return textResult(formatError('desktop_mouse_move', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_double_click — post a double-click at screen coordinates
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopDoubleClickTool(server: McpServer) {
  server.tool(
    'desktop_double_click',
    'Post a left-button double-click at absolute screen coordinates. Needed for opening files in Finder, selecting words in text, and other double-click interactions. Uses CGEvent via JXA — requires Accessibility permission.',
    {
      x: z.number().int().describe('X coordinate in screen points.'),
      y: z.number().int().describe('Y coordinate in screen points.'),
    },
    async ({ x, y }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // Event types: 1 = leftMouseDown, 2 = leftMouseUp. We post down/up/down/up with
      // clickCount field set to 2 on the second pair — that's how macOS distinguishes
      // a double-click from two single clicks.
      const jxa = `
ObjC.import('CoreGraphics');
var pt = { x: ${x}, y: ${y} };
var down1 = $.CGEventCreateMouseEvent(null, 1, pt, 0);
var up1   = $.CGEventCreateMouseEvent(null, 2, pt, 0);
// kCGMouseEventClickState = 1
$.CGEventSetIntegerValueField(down1, 1, 2);
$.CGEventSetIntegerValueField(up1, 1, 2);
var down2 = $.CGEventCreateMouseEvent(null, 1, pt, 0);
var up2   = $.CGEventCreateMouseEvent(null, 2, pt, 0);
$.CGEventSetIntegerValueField(down2, 1, 2);
$.CGEventSetIntegerValueField(up2, 1, 2);
$.CGEventPost(0, down1);
$.CGEventPost(0, up1);
$.CGEventPost(0, down2);
$.CGEventPost(0, up2);
'ok';
      `.trim()

      try {
        await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 5000 })
        return textResult(`Double-clicked at (${x}, ${y})`)
      } catch (err) {
        return textResult(formatError('desktop_double_click', err))
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════════
// desktop_drag — drag from one point to another
// ═══════════════════════════════════════════════════════════════════

export function registerDesktopDragTool(server: McpServer) {
  server.tool(
    'desktop_drag',
    'Perform a left-button drag from (x1, y1) to (x2, y2) with optional intermediate steps. Use for dragging files in Finder, moving sliders, reordering list items, and drawing. Uses CGEvent via JXA — requires Accessibility permission.',
    {
      x1: z.number().int().describe('Start X coordinate.'),
      y1: z.number().int().describe('Start Y coordinate.'),
      x2: z.number().int().describe('End X coordinate.'),
      y2: z.number().int().describe('End Y coordinate.'),
      steps: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Intermediate drag-points between start and end (default 20). More steps = smoother drag, which some apps require to register.'),
    },
    async ({ x1, y1, x2, y2, steps = 20 }) => {
      if (!isMacOS()) return textResult(PLATFORM_ERROR)

      // Event types: 1 = leftMouseDown, 6 = leftMouseDragged, 2 = leftMouseUp.
      const jxa = `
ObjC.import('CoreGraphics');
var x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, steps = ${steps};
var down = $.CGEventCreateMouseEvent(null, 1, { x: x1, y: y1 }, 0);
$.CGEventPost(0, down);
for (var i = 1; i <= steps; i++) {
  var t = i / steps;
  var px = x1 + (x2 - x1) * t;
  var py = y1 + (y2 - y1) * t;
  var drag = $.CGEventCreateMouseEvent(null, 6, { x: px, y: py }, 0);
  $.CGEventPost(0, drag);
}
var up = $.CGEventCreateMouseEvent(null, 2, { x: x2, y: y2 }, 0);
$.CGEventPost(0, up);
'ok';
      `.trim()

      try {
        await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 10_000 })
        return textResult(`Dragged from (${x1}, ${y1}) to (${x2}, ${y2}) in ${steps} steps`)
      } catch (err) {
        return textResult(formatError('desktop_drag', err))
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
  registerDesktopClipboardGetTool(server)
  registerDesktopClipboardSetTool(server)
  registerDesktopScreenshotRegionTool(server)
  registerDesktopMenuClickTool(server)
  registerDesktopWindowMoveTool(server)
  registerDesktopWindowResizeTool(server)
  registerDesktopScrollTool(server)
  registerDesktopAppLaunchTool(server)
  registerDesktopAppQuitTool(server)
  registerDesktopFrontmostAppTool(server)
  registerDesktopOpenUrlTool(server)
  registerDesktopOpenPathTool(server)
  registerDesktopNotificationTool(server)
  registerDesktopMouseMoveTool(server)
  registerDesktopDoubleClickTool(server)
  registerDesktopDragTool(server)
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
