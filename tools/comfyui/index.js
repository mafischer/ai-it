/**
 * ComfyUI MCP Tool Registration
 */
import { registerTools as registerComfyUI } from "./tools.js";

export function register(server) {
  registerComfyUI(server);
}
