import type { RuntimeDialog } from "./types.js";

type Focus = "checkbox" | "previous" | "done";
type State = { kind: "welcome" } | { kind: "terms"; checked: boolean; focus: Focus };
const TERMS = "Terms of Service & Data Use";
const HINT = "↑/↓ Navigate · enter ";
const WARNING = "AI coding agents are known to have certain security risks, including autonomous code execution, data exfiltration, prompt injection and supply chain risks. Ensure that you monitor and verify all actions taken by the agent.";
const CONSENT = "Yes, I agree to help improve Antigravity CLI by allowing Google to collect and use my Interactions data, subject to the Google Antigravity CLI Terms of Service and Google Privacy Policy. I understand I can choose to opt out later whenever I want via my settings.";
const COLOURS = ["terminal", "light", "solarized light", "colorblind-friendly light", "dark", "solarized dark", "colorblind-friendly dark", "tokyo night"];
const rowsOf = (pane: string) => pane.replace(/\r/g, "").split("\n").map(s => s.trimEnd()).filter(s => s.trim());

/** Only the wizard's own hint and optional status may end the current screen. */
function contentRows(pane: string): string[] | null {
  const rows = rowsOf(pane);
  if (/^\s*Context \d+% used$/.test(rows.at(-1) ?? "")
    || /^[ \t]{20,}(?:auto · )?(?:Gemini|Claude|GPT)[A-Za-z0-9 .()·_-]+$/.test(rows.at(-1) ?? "")) rows.pop();
  if (!new RegExp("^\\s*" + HINT + "[A-Za-z]+$").test(rows.at(-1) ?? "")) return null;
  return rows;
}

/** Narrow captured/screenshot-derived grammar. Unknown, cropped, quoted or ambiguous focus never grants a key. */
export function agyOnboardingState(pane: string): State | null {
  const rows = contentRows(pane);
  if (!rows) return null;
  const terms = rows.map(row => row.trim()).lastIndexOf(TERMS);
  if (terms >= 0) {
    const body = rows.slice(terms + 1, -1);
    const divider = body.findIndex(row => /^\s*-{10,}$/.test(row));
    if (divider < 0 || body.slice(0, divider).map(s => s.trim()).join(" ") !== WARNING) return null;
    const rest = body.slice(divider + 1);
    const checkbox = /^\s*(>[ \t]+)?\[(x| )\] (.*)$/.exec(rest[0] ?? "");
    const links = rest.findIndex(row => row.trim() === "Links:");
    if (!checkbox || links < 1) return null;
    if ([checkbox[3], ...rest.slice(1, links).map(s => s.trim())].join(" ") !== CONSENT) return null;
    if (rest.length !== links + 4
      || rest[links + 1]?.trim() !== "- Terms of Service: https://antigravity.google/terms"
      || rest[links + 2]?.trim() !== "- Privacy Policy: https://policies.google.com/privacy") return null;
    const buttons = /^\s*(?:>([ \t]+)Previous[ \t]+\[Done\]|\[Previous\][ \t]+>([ \t]+)Done|\[Previous\][ \t]+\[Done\])$/.exec(rest[links + 3]!);
    if (!buttons) return null;
    const focuses = [checkbox[1] ? "checkbox" : null, buttons[1] ? "previous" : null, buttons[2] ? "done" : null].filter(Boolean);
    if (focuses.length !== 1) return null;
    const focus = focuses[0] as Focus;
    if (rows.at(-1)!.trim() !== HINT + (focus === "checkbox" ? "Toggle" : "Confirm")) return null;
    return { kind: "terms", checked: checkbox[2] === "x", focus };
  }
  const welcome = rows.map(row => row.trim()).lastIndexOf("Welcome to Antigravity CLI!");
  if (welcome < 0) return null;
  // The preview begins beside the heading and continues below the palette. Its
  // right-column sample code is decoration, never another focus/control row.
  const heading = rows[welcome + 1] ?? "";
  const previewColumn = heading.indexOf("╭");
  const left = (row: string): string => {
    if (previewColumn >= 24 && /^ ?[╭│╰]/.test(row.slice(previewColumn))) return row.slice(0, previewColumn).trimEnd();
    return row;
  };
  const controls = rows.slice(welcome + 1, -1).map(left).filter(row => row.trim());
  if (controls.length !== COLOURS.length + 2 || controls[0]?.trim() !== "Choose your color scheme:") return null;
  const options = controls.slice(1, -1);
  for (let i = 0; i < COLOURS.length; i++) {
    const expected = i === 0 ? "> terminal" : COLOURS[i];
    if (options[i]?.trim() !== expected) return null;
  }
  if (controls.at(-1)?.trim() !== "[Next]" || rows.at(-1)?.trim() !== HINT + "Confirm") return null;
  return { kind: "welcome" };
}

/** Broad enough to hold an unknown wizard variant, but still bottom-anchored to its own UI hint. */
function wizardVisible(pane: string): boolean {
  const rows = contentRows(pane);
  return !!rows && rows.some(row => row.trim() === TERMS || row.trim() === "Welcome to Antigravity CLI!");
}

/** Every phase sends ONE key; the daemon re-reads under its pane lock and claims it once per physical launch. */
export function agyOnboardingDialogs(): RuntimeDialog[] {
  const phase = (id: string, pattern: RegExp, accepts: (state: State) => boolean, key: string): RuntimeDialog => ({
    pattern,
    isActive: pane => { const state = agyOnboardingState(pane); return !!state && accepts(state); },
    keys: [key],
    description: `Antigravity onboarding: ${id}`,
    inputBlocked: true,
    blocksDelivery: true,
    answeredByAgend: true,
    verifyAfterKeys: true,
    oncePerLaunch: true,
    autoResolutionKey: `antigravity-onboarding-${id}`,
  });
  return [
    phase("default-colour", /Welcome to Antigravity CLI!/, s => s.kind === "welcome", "Enter"),
    phase("sharing-off", /> \[x\] Yes, I agree/, s => s.kind === "terms" && s.checked && s.focus === "checkbox", "Enter"),
    phase("unchecked-next", /> \[ \] Yes, I agree/, s => s.kind === "terms" && !s.checked && s.focus === "checkbox", "Down"),
    phase("unchecked-previous", /> Previous/, s => s.kind === "terms" && !s.checked && s.focus === "previous", "Right"),
    // Done is NEVER granted by a checked box, even when the button itself has focus.
    phase("unchecked-done", /> Done/, s => s.kind === "terms" && !s.checked && s.focus === "done", "Enter"),
    phase("checked-previous", /\[x\][\s\S]*> Previous/, s => s.kind === "terms" && s.checked && s.focus === "previous", "Up"),
    phase("checked-done", /\[x\][\s\S]*> Done/, s => s.kind === "terms" && s.checked && s.focus === "done", "Up"),
    {
      pattern: /Terms of Service & Data Use|Welcome to Antigravity CLI!/,
      isActive: wizardVisible,
      keys: [],
      holdOnly: true,
      inputBlocked: true,
      blocksDelivery: true,
      description: "Antigravity first-run wizard needs human confirmation",
    },
  ];
}
