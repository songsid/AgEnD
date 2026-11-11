import { restoreWorkspace, saveWorkspace } from "./chat-workspace-model.js";

/** Per-device display preference, in a server-derived opaque viewer/fleet namespace. Storage failure is harmless. */
export function workspaceMemory(storage, scope) {
  const key = typeof scope === "string" && /^[a-f0-9]{64}$/.test(scope) ? `agend_chat_workspace_v1:${scope}` : null;
  return {
    read() {
      if (!key) return null;
      try { const text = storage.getItem(key); return text && text.length <= 4096 ? restoreWorkspace(JSON.parse(text)) : null; } catch { return null; }
    },
    write(w) { if (key) try { storage.setItem(key, JSON.stringify(saveWorkspace(w))); } catch { /* memory-only */ } },
    clear() { if (key) try { storage.removeItem(key); } catch { /* memory-only */ } },
  };
}
