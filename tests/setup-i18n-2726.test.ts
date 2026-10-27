/**
 * #2726 part 2: the setup pages in English and 繁體中文 — the browser's language, else the one chosen on the page
 * (kept as the dashboard's `agend_lang`). The dictionaries match key for key; every key a page uses is in them; every
 * message the host can answer the pages with has its 繁體中文 (driven from the real sources); and the pages' own
 * scripts, run with an inert DOM, say their words in the chosen language and follow the toggle.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SETUP_CODE_PAGE_HTML, SETUP_FORM_HTML } from "../src/setup-form.js";
import { SETUP_CODE_STRINGS, SETUP_FORM_STRINGS, setupI18nRuntime } from "../src/setup-i18n.js";
// @ts-expect-error — a JS module of the app, with no types
import { HOST_CODES as SETUP_HOST_CODES, HOST_MESSAGES as SETUP_HOST_MESSAGES, hostText } from "../src/ui/shared/setup-host-text.js";
// @ts-expect-error — a JS module of the app, with no types
import { SIGNIN_STRINGS, mountStructuredSignIns } from "../src/ui/structured-signin.js";
import { agentConflict, newConnectionConflict, validateWizardInput, webOnlyConflict } from "../src/quickstart-api.js";
import { newTokenEnvConflict } from "../src/token-env-name.js";

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const script = (html: string) => html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
const CJK = /[一-鿿]/;

describe("#2726 the dictionaries", () => {
  it("each has the same keys in both languages, and every 繁體中文 text is filled", () => {
    for (const [name, table] of Object.entries({ SETUP_CODE_STRINGS, SETUP_FORM_STRINGS, SETUP_HOST_CODES, SIGNIN_STRINGS }) as [string, Record<string, Record<string, string>>][]) {
      expect(Object.keys(table["zh-TW"]!).sort(), name).toEqual(Object.keys(table.en!).sort());
      for (const [key, text] of Object.entries(table["zh-TW"]!)) expect(text.trim(), `${name}.${key}`).not.toBe("");
    }
  });
  it("the {0} holes match between the languages", () => {
    const holes = (text: string) => [...text.matchAll(/\{\d\}/g)].map(m => m[0]).sort().join();
    for (const table of [SETUP_CODE_STRINGS, SETUP_FORM_STRINGS, SIGNIN_STRINGS] as Record<string, Record<string, string>>[]) {
      for (const [key, text] of Object.entries(table.en!)) expect(holes(table["zh-TW"]![key]!), key).toBe(holes(text));
    }
    for (const [en, zh] of SETUP_HOST_MESSAGES as [string, string][]) { expect(holes(zh), en).toBe(holes(en)); expect(zh, en).toMatch(CJK); }
  });
  it("every key a page uses is in its dictionary (markup and script)", () => {
    for (const [html, table] of [[SETUP_CODE_PAGE_HTML, SETUP_CODE_STRINGS], [SETUP_FORM_HTML, SETUP_FORM_STRINGS]] as const) {
      const used = new Set<string>();
      for (const m of html.matchAll(/data-i18n(?:-placeholder|-label)?="([^"]+)"/g)) used.add(m[1]!);
      for (const pattern of [/\btr\("([A-Za-z_]+)"(?=[,)])/g, /\bsetFinishLabel\("([A-Za-z_]+)"\)/g, /\bsay\("[^"]+", "([A-Za-z_]+)"/g, /\bfinishSay\([^,]+, "([A-Za-z_]+)"/g]) {
        for (const m of html.matchAll(pattern)) used.add(m[1]!);
      }
      for (const m of html.matchAll(/(?:sayHost|finishHost)\([^)]*?, "([A-Za-z_]+)"\)/g)) used.add(m[1]!);
      expect(used.size).toBeGreaterThan(table === SETUP_CODE_STRINGS ? 4 : 40);
      for (const key of used) expect(table.en, key).toHaveProperty(key);
    }
    for (const m of src("ui/structured-signin.js").matchAll(/\btr\("([A-Za-z_]+)"(?=[,)])/g)) expect(SIGNIN_STRINGS.en, m[1]).toHaveProperty(m[1]!);
  });
});

/** The runtime alone, as the pages run it, in a language. */
function runtime(lang: string, strings = SETUP_FORM_STRINGS) {
  const context = createContext({ navigator: { language: lang }, document: { getElementById: () => null, querySelectorAll: () => [] } });
  runInContext(setupI18nRuntime(strings), context);
  return { trHost: (text: string) => runInContext("trHost", context)(text) as string, tr: (key: string, ...v: unknown[]) => runInContext("tr", context)(key, ...v) as string };
}

describe("#2726 every message the host can answer with has its 繁體中文", () => {
  const zh = runtime("zh-TW"), en = runtime("en-US");
  const translated = (text: string) => {
    const out = zh.trHost(text);
    expect(out, text).not.toBe(text); expect(out, text).toMatch(CJK);
    expect(en.trHost(text), "English stays English (a code becomes words)").toBe(SETUP_HOST_CODES.en[text] ?? text);
  };
  it("the wizard's validation and conflicts (driven)", () => {
    const WEB = { web_only: true, backend: "claude-code", working_directory: "", instance_name: "a" };
    const BOT = { platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code", working_directory: "", instance_name: "a", admin_user_id: "42" };
    for (const input of [{ ...WEB, working_directory: "x" }, { ...WEB, instance_name: "a b" }, { ...WEB, backend: "nope" }, { ...WEB, token_env: "X" },
      { ...WEB, platform: "telegram" }, { ...BOT, platform: "irc" }, { ...BOT, token_env: "lower" }, { ...BOT, group_id: "abc" },
      { ...BOT, admin_user_id: "0" }, { ...BOT, platform: "discord", admin_user_id: "1" }, { ...BOT, working_directory: "x" }]) {
      const message = validateWizardInput(input as never);
      expect(message, JSON.stringify(input)).toBeTruthy(); translated(message!);
    }
    const cfg = { instances: { a: { working_directory: "/w", backend: "codex" } }, defaults: {}, channel: { id: "telegram", type: "telegram", bot_token_env: "AGEND_BOT_TOKEN" } } as never;
    translated(agentConflict({ instance_name: "a" }, cfg)!);
    translated(agentConflict({ instance_name: "zz", existing_agent: true }, cfg)!);
    translated(agentConflict({ instance_name: "general" }, cfg)!);   // M-2069: the General's name, on a fleet with a connection
    translated(agentConflict({ instance_name: "general", working_directory: "/home/you/app" }, { instances: {}, defaults: {} } as never)!);   // #2744 review
    translated(webOnlyConflict(cfg)!);
    translated(newConnectionConflict({ token_env: "", channel_id: "telegram" }, { channels: [{ id: "telegram", type: "telegram", token_env: "T", group_id: null }] })!);
    translated(newTokenEnvConflict("AGEND_BOT_TOKEN", [{ id: "telegram", token_env: "AGEND_BOT_TOKEN" }])!);
  });
  it("every error literal of the setup host and the wizard's routes", () => {
    const literals = new Set<string>();
    for (const m of src("setup-host.ts").matchAll(/this\.deny\(res, \d+, "([^"]+)"\)/g)) literals.add(m[1]!);
    for (const m of src("quickstart-api.ts").matchAll(/\berror: "([^"]+)"/g)) literals.add(m[1]!);
    for (const m of src("provider-probe.ts").matchAll(/\berror: "([^"]+)"/g)) literals.add(m[1]!);   // the Discord channel list (the wizard's picker)
    expect(literals.size).toBeGreaterThan(15);
    for (const text of literals) {
      // The sign-in endpoints' codes are said by the sign-in cards (structured-signin.js), in both languages.
      if (SIGNIN_STRINGS.en[`error_${text}` as keyof typeof SIGNIN_STRINGS.en]) { expect(SIGNIN_STRINGS["zh-TW"][`error_${text}` as keyof typeof SIGNIN_STRINGS.en]).toMatch(CJK); continue; }
      translated(text);
    }
    // Built from parts: the attempts left, and the polling conflicts.
    for (const text of ["incorrect — 3 attempts left", "incorrect — 1 attempt left", "Discord replied 401", "Telegram replied 502",
      "This bot token is already being polled by the running fleet. Enter the group id by hand, or stop AgEnD first.",
      "Another process is already reading this bot's updates. Stop it, or enter the group id by hand."]) translated(text);
    expect(zh.trHost("incorrect — 3 attempts left")).toBe("代碼不正確 —— 還可以再試 3 次");
  });
  it("the confirmation gate's codes are words in both languages; an unknown text stays as it came", () => {
    for (const code of Object.keys(SETUP_HOST_CODES.en)) { expect(en.trHost(code)).toBe(SETUP_HOST_CODES.en[code]); expect(zh.trHost(code)).toBe(SETUP_HOST_CODES["zh-TW"][code]); }
    for (const code of ["invalid_quickstart", "agent_conflict", "connection_exists"]) expect(src("settings-effect.ts")).toContain(`"${code}"`);
    expect(zh.trHost("Unauthorized")).toBe("Unauthorized");
    expect(zh.trHost("a. b")).toBe("a. b");
  });
});

describe("#2726 one table for the setup pages and the dashboard (src/ui/shared/setup-host-text.js)", () => {
  it("pasted into both setup pages as it is: no imports, no closing tag; served to the dashboard at /assets", () => {
    const module = src("ui/shared/setup-host-text.js");
    expect(module).not.toMatch(/^import /m); expect(module).not.toContain("</");
    for (const html of [SETUP_CODE_PAGE_HTML, SETUP_FORM_HTML]) { expect(script(html)).toContain("function hostText(text, lang)"); expect(script(html)).not.toMatch(/^export /m); }
    expect(src("auth-api.ts")).toContain('"setup-host-text.js"');
    for (const file of ["ui/settings-wizard.js", "ui/settings-token.js", "ui/panel-settings.js", "ui/settings-discord.js"]) expect(src(file)).toContain('import { hostText } from "/assets/setup-host-text.js";');
  });
  it("hostText: codes are words in both languages, the host's words in 繁體中文, anything else as it came", () => {
    expect(hostText("invalid_quickstart", "en")).toBe("This setup is not valid. Review it and try again.");
    expect(hostText("invalid_quickstart", "zh-TW")).toBe("這份設定無效。請檢查後再試一次。");
    expect(hostText("guild id must be numeric", "zh-TW")).toBe("伺服器 id 必須是數字");
    expect(hostText("codex was not found on this host; the agent will fail to start until it is installed.", "zh-TW")).toBe("這台主機上找不到 codex；安裝之前，agent 會無法啟動。");
    expect(hostText("codex was not found on this host; the agent will fail to start until it is installed.", "en")).toBe("codex was not found on this host; the agent will fail to start until it is installed.");
    expect([hostText("Unauthorized", "zh-TW"), hostText(undefined, "zh-TW"), hostText("constructor", "zh-TW"), hostText("toString", "en")]).toEqual(["Unauthorized", undefined, "constructor", "toString"]);
  });
});

/** The setup form's own script with an inert DOM (as tests/settings-setup-browser-1423.test.ts), in a language. */
function form(opts: { language?: string; stored?: string | null } = {}) {
  const elements = new Map<string, any>();
  const element = (tag = "input"): any => {
    const item: any = { tag, dataset: {}, children: [], disabled: false, hidden: false, value: "", textContent: "", className: "", listeners: new Map(),
      addEventListener(event: string, cb: any) { this.listeners.set(event, cb); }, append(...c: any[]) { this.children.push(...c); },
      replaceChildren(...c: any[]) { this.children = c; this.textContent = c.map((x: any) => typeof x === "string" ? x : x.textContent).join(""); } };
    Object.defineProperty(item, "innerHTML", { set() { item.children = []; } });
    return item;
  };
  for (const m of SETUP_FORM_HTML.matchAll(/<(input|select|button|div|span|pre)[^>]*\bid="([^"]+)"/g)) { const e = element(m[1]); e.id = m[2]; elements.set(e.id, e); }
  elements.get("name").value = "agent-1";
  const store = new Map<string, string>(opts.stored ? [["agend_lang", opts.stored]] : []);
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const documentElement = { lang: "" };
  const document: any = { title: "", documentElement, getElementById: (id: string) => elements.get(id), createElement: element,
    querySelectorAll: () => [...elements.values()].filter(e => ["input", "select", "button"].includes(e.tag) && e.id !== "finish") };
  const fetch = vi.fn(async (path: string) => ({ ok: true, status: 200, json: async () =>
    path === "api/settings/quickstart/environment" ? { backends: ["kiro-cli"], workspaces_dir: "/root/.agend/workspaces" } : path === "api/settings/pending" ? [] : {} }));
  runInContext(script(SETUP_FORM_HTML), createContext({ fetch, document, localStorage, navigator: { language: opts.language ?? "en-US" },
    crypto: { randomUUID: () => "k" }, setTimeout: vi.fn(), Date, performance: { now: () => 0 } }));
  const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
  return { $: (id: string) => elements.get(id), document, store, flush };
}

describe("#2726 the setup form in a language", () => {
  it("the browser's 繁體中文: its words, the default folder under the field, the title and <html lang>", async () => {
    const p = form({ language: "zh-TW" }); await p.flush();
    expect(p.document.documentElement.lang).toBe("zh-Hant");
    expect(p.document.title).toBe("設定 AgEnD");
    expect(p.$("finish").textContent).toBe("建立並啟動 AgEnD");
    expect(p.$("platformHint").textContent).toBe(SETUP_FORM_STRINGS["zh-TW"].hintTelegram);
    expect(p.$("backendHint").textContent).toBe("在這台主機上找到：kiro-cli");
    expect(p.$("dirHint").textContent).toBe("留空的話，agent 會有自己的資料夾 /root/.agend/workspaces/general，由 AgEnD 建立。若要填寫，必須是絕對路徑。");
  });
  it("English otherwise; the default follows the agent's name", async () => {
    const p = form(); await p.flush();
    expect(p.document.documentElement.lang).toBe("en");
    expect(p.$("dirHint").textContent).toBe("Leave it empty and the agent gets its own folder, /root/.agend/workspaces/general, which AgEnD creates. A path you enter must be absolute.");
    p.$("name").value = "helper"; p.$("name").listeners.get("input")();
    expect(p.$("dirHint").textContent).toContain("/root/.agend/workspaces/helper,");
  });
  it("M-2069: a chat setup's first agent is general, said under the field; web only is agent-1; a typed name is kept", async () => {
    const p = form(); await p.flush();
    expect([p.$("name").value, p.$("generalNote").hidden]).toEqual(["general", false]);
    p.$("pickWeb").onclick();
    expect([p.$("name").value, p.$("generalNote").hidden, p.$("dirHint").textContent.includes("/workspaces/agent-1,")]).toEqual(["agent-1", true, true]);
    p.$("pickDiscord").onclick();
    expect([p.$("name").value, p.$("generalNote").hidden]).toEqual(["general", false]);
    p.$("name").value = "boss"; p.$("name").listeners.get("input")();
    p.$("pickWeb").onclick(); p.$("pickTelegram").onclick();
    expect(p.$("name").value, "a typed name is never replaced").toBe("boss");
  });
  it("#2744 review: a typed directory makes the first agent a worker (agent-1, no note); cleared, it is the General again", async () => {
    const p = form(); await p.flush();
    p.$("dir").value = "/home/you/projects/app"; p.$("dir").listeners.get("input")();
    expect([p.$("name").value, p.$("generalNote").hidden]).toEqual(["agent-1", true]);
    p.$("dir").value = ""; p.$("dir").listeners.get("input")();
    expect([p.$("name").value, p.$("generalNote").hidden]).toEqual(["general", false]);
  });
  it("the toggle switches every shown text at once and is kept as the dashboard's agend_lang; a kept choice beats the browser", async () => {
    const p = form({ language: "en-US" }); await p.flush();
    p.$("lang").onclick();
    expect(p.store.get("agend_lang")).toBe("zh-TW");
    expect([p.document.documentElement.lang, p.$("finish").textContent, p.$("platformHint").textContent]).toEqual(["zh-Hant", "建立並啟動 AgEnD", SETUP_FORM_STRINGS["zh-TW"].hintTelegram]);
    p.$("lang").onclick();
    expect([p.store.get("agend_lang"), p.$("finish").textContent]).toEqual(["en", "Create and start AgEnD"]);
    const kept = form({ language: "zh-TW", stored: "en" }); await kept.flush();
    expect(kept.$("finish").textContent).toBe("Create and start AgEnD");
  });
});

describe("#2726 the code page in a language", () => {
  function codePage(language: string) {
    const nodes = new Map<string, any>();
    const node = (id: string): any => nodes.get(id) ?? (nodes.set(id, { id, textContent: "", disabled: false, children: [] as any[],
      addEventListener(_e: string, cb: any) { this.submit = cb; }, replaceChildren(...c: any[]) { this.children = c; } }), nodes.get(id));
    const fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "incorrect — 4 attempts left" }) }));
    const document: any = { title: "", documentElement: { lang: "" }, getElementById: node, createElement: () => ({ textContent: "" }), querySelectorAll: () => [] };
    runInContext(script(SETUP_CODE_PAGE_HTML), createContext({ fetch, document, navigator: { language }, location: { reload: vi.fn() }, JSON }));
    return { node, document };
  }
  it("繁體中文: the lead keeps the command as code, and a refusal is said in 繁體中文", async () => {
    const p = codePage("zh-Hant-TW");
    expect(p.document.title).toBe("設定 AgEnD");
    const lead = p.node("lead").children;
    expect([lead[0], lead[1].textContent, lead[2]]).toEqual(["請輸入執行 ", "agend setup", " 的終端機上顯示的設定代碼。"]);
    await p.node("f").submit({ preventDefault() {} });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(p.node("msg").textContent).toBe("代碼不正確 —— 還可以再試 4 次");
  });
});

describe("#2726 the sign-in cards follow the page's language", () => {
  it("<html lang> on the setup page; the dashboard's own choice when it passes one; relabel redraws at once", async () => {
    const make = (tag: string): any => { const n: any = { tag, textContent: "", dataset: {}, children: [] as any[], setAttribute() {}, append(...c: any[]) { n.children.push(...c); },
      replaceChildren() { n.children = []; } }; return n; };
    const documentElement = { lang: "zh-Hant" };
    const root = make("div"); root.ownerDocument = { documentElement, createElement: make };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ selected: ["codex"], pending: ["codex"], skipped: [], states: {}, login: null, ready: false }) }));
    const cards = mountStructuredSignIns(root, { endpoint: "x", fetcher: fetcher as never });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(root.children[0].textContent).toBe(SIGNIN_STRINGS["zh-TW"].heading);
    documentElement.lang = "en"; cards.relabel();
    expect(root.children[0].textContent).toBe(SIGNIN_STRINGS.en.heading);
    cards.dispose();
    const chosen = make("div"); chosen.ownerDocument = { documentElement: { lang: "en" }, createElement: make };
    const dashboard = mountStructuredSignIns(chosen, { endpoint: "x", fetcher: fetcher as never, lang: () => "zh-TW" });
    expect(chosen.children[0].textContent).toBe(SIGNIN_STRINGS["zh-TW"].heading);
    dashboard.dispose();
  });
});
