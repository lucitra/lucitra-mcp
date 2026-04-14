// Library entry point — re-exports only, no side effects.
export { runAppleScript, asString } from './applescript.js'
export type { AppleScriptOptions } from './applescript.js'
export {
  registerAllTools,
  registerDesktopClickTool,
  registerDesktopTypeTool,
  registerDesktopKeyTool,
  registerDesktopFocusTool,
  registerDesktopListWindowsTool,
  registerDesktopReadWindowTool,
  registerDesktopRunAppleScriptTool,
} from './tools.js'
