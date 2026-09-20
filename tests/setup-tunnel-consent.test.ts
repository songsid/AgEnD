import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { confirmPublicTunnel, noTunnelBinaryMessage, publicTunnelWarning, type ConsentIo } from "../src/setup-tunnel-consent.js";

function io(over: Partial<ConsentIo> = {}): ConsentIo & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    isTTY: true,
    say: line => { said.push(line); },
    ask: async question => { asked.push(question); return "y"; },
    said,
    asked,
    ...over,
  } as ConsentIo & { said: string[]; asked: string[] };
}

describe("what the warning has to say", () => {
  const text = () => publicTunnelWarning(15).join("\n");

  it("says the bot token goes through Cloudflare, not just that traffic does", () => {
    // sol's Web Terminal wording covers a terminal session that ends. This
    // page carries a long-lived bot token and an admin id, and consenting to
    // one is not consenting to the other.
    expect(text()).toContain("bot token");
    expect(text()).toContain("Cloudflare");
    expect(text()).toMatch(/TLS ends at their edge|Cloudflare can see it/);
    expect(text()).toContain("admin");
  });

  it("says a stranger with the link can close the page", () => {
    // The residual risk the random path does not cover: the link reaches
    // whoever it reaches, and five wrong codes ends the session.
    expect(text()).toMatch(/five times|five wrong/i);
    expect(text()).toContain("agend setup");
    expect(text()).toMatch(/group chat/i);
  });

  it("says how long the door stays open, in the units it was given", () => {
    expect(publicTunnelWarning(15).join("\n")).toContain("15 minutes");
    expect(publicTunnelWarning(10).join("\n")).toContain("10 minutes");
  });
});

describe("the question is asked every time", () => {
  it("opens the tunnel only on an explicit yes", async () => {
    for (const answer of ["y", "Y", "yes", "YES", " y "]) {
      const box = io({ ask: async () => answer });
      await expect(confirmPublicTunnel(box, 15)).resolves.toEqual({ granted: true });
    }
  });

  it("treats everything else as no, including just pressing enter", async () => {
    // Someone who hits enter to get past a prompt has not read it.
    for (const answer of ["", " ", "n", "no", "sure", "ok", "1"]) {
      const box = io({ ask: async () => answer });
      await expect(confirmPublicTunnel(box, 15)).resolves.toEqual({ granted: false, reason: "declined" });
    }
  });

  it("shows the warning before asking, not after", async () => {
    const order: string[] = [];
    const box = io({
      say: line => { if (line.trim()) order.push("said"); },
      ask: async () => { order.push("asked"); return "y"; },
    });

    await confirmPublicTunnel(box, 15);

    expect(order[0]).toBe("said");
    expect(order.at(-1)).toBe("asked");
  });

  it("refuses with no terminal, rather than assuming consent", async () => {
    // Nobody being there to object is the reason to refuse, not a reason to
    // proceed. There is no flag that answers this in advance.
    const box = io({ isTTY: false, ask: async () => { throw new Error("must not ask"); } });

    const result = await confirmPublicTunnel(box, 15);

    expect(result).toEqual({ granted: false, reason: "no-tty" });
    expect(box.asked).toEqual([]);
    expect(box.said.join(" ")).toContain("without a terminal");
    // Still told them what they would have been consenting to.
    expect(box.said.join(" ")).toContain("bot token");
  });
});

describe("when there is no cloudflared", () => {
  it("says a phone cannot open the link, and what to do instead", () => {
    const text = noTunnelBinaryMessage().join("\n");

    expect(text).toMatch(/phone will not be able/i);
    expect(text).toContain("Install cloudflared");
    expect(text).toContain("browser on this machine");
  });
});

describe("the command asks before it builds anything", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const setupCommand = cli.slice(cli.indexOf('.command("setup")'), cli.indexOf('.command("quickstart")'));

  it("confirms before the host is constructed", () => {
    // Order matters: the lock, the listener and cloudflared are all created by
    // `host.start()`. Asking afterwards would mean the tunnel already existed
    // by the time anyone said no.
    const confirmAt = setupCommand.indexOf("confirmPublicTunnel(");
    const constructAt = setupCommand.indexOf("new SetupHost(");
    const startAt = setupCommand.indexOf("await host.start()");

    expect(confirmAt).toBeGreaterThan(-1);
    expect(constructAt, "host built before consent").toBeGreaterThan(confirmAt);
    expect(startAt, "host started before consent").toBeGreaterThan(confirmAt);
  });

  it("stops the command when consent is refused", () => {
    expect(setupCommand).toContain("if (!consent.granted) { process.exit(1); }");
  });

  it("prints the no-cloudflared guidance when a tunnel was asked for and there is none", () => {
    // Otherwise `--tunnel` quietly prints a loopback link under a flag that
    // promised a phone could open it.
    expect(setupCommand).toContain("if (opts.tunnel && !started.publicUrl) {");
    expect(setupCommand).toContain("noTunnelBinaryMessage()");
  });

  it("asks only when a tunnel was requested", () => {
    // A local setup page exposes nothing new and must not grow a prompt.
    expect(setupCommand).toMatch(/if \(opts\.tunnel\) \{\s*\n\s*const \{ confirmPublicTunnel \}/);
  });

  it("has no flag that answers the question in advance", () => {
    // `--yes` would be a per-invocation consent and defensible, but it is also
    // the thing that ends up in a script, and then nobody reads the warning
    // again. There is no configuration for this either.
    expect(setupCommand).not.toMatch(/--yes|assumeYes|skipConfirm/);
    // And the gate itself takes no escape hatch: two arguments, neither of
    // which can mean "already agreed".
    const consent = readFileSync(new URL("../src/setup-tunnel-consent.ts", import.meta.url), "utf8");
    const signature = consent.slice(consent.indexOf("export async function confirmPublicTunnel"));
    expect(signature.slice(0, signature.indexOf(")"))).toBe(
      "export async function confirmPublicTunnel(io: ConsentIo, ttlMinutes: number",
    );
  });
});

describe("the page stops watching after a minute", () => {
  const form = readFileSync(new URL("../src/setup-form.ts", import.meta.url), "utf8");

  it("caps the wait and sends the person back to the machine", () => {
    expect(form).toContain("Date.now() + 60_000");
    expect(form).toContain("has not come up within 60 seconds");
    // Escaped in the page's template literal, hence the backslashes here.
    expect(form).toContain("\\`agend start\\` on the machine itself");
    // Never a dashboard link: it binds loopback, so a phone cannot open it.
    expect(form).not.toContain("Open /settings");
  });
});
