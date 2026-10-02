import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleetConfig } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function load(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-cfg-"));
  dirs.push(dir);
  const p = join(dir, "fleet.yaml");
  writeFileSync(p, yaml);
  return loadFleetConfig(p);
}

describe("login / web_terminal / hostname config", () => {
  it("parses the new sections and passes hostname through", () => {
    const cfg = load(`
defaults: {}
instances: {}
hostname: fleet.example
login:
  mode: relay
web_terminal:
  enabled: true
  bind: 100.64.0.7
  ttl_minutes: 5
`);
    expect(cfg.hostname).toBe("fleet.example");
    expect(cfg.login).toEqual({ mode: "relay" });
    expect(cfg.web_terminal).toEqual({ enabled: true, bind: "100.64.0.7", ttl_minutes: 5 });
  });

  it("absent sections stay undefined (web mode by default at runtime)", () => {
    const cfg = load("defaults: {}\ninstances: {}\n");
    expect(cfg.login).toBeUndefined();
    expect(cfg.web_terminal).toBeUndefined();
    expect(cfg.hostname).toBeUndefined();
  });

  it("clamps ttl_minutes into the engine's 1..20 range", () => {
    expect(load("defaults: {}\ninstances: {}\nweb_terminal:\n  ttl_minutes: 90\n").web_terminal?.ttl_minutes).toBe(20);
    expect(load("defaults: {}\ninstances: {}\nweb_terminal:\n  ttl_minutes: 0\n").web_terminal?.ttl_minutes).toBe(1);
    expect(load("defaults: {}\ninstances: {}\nweb_terminal:\n  ttl_minutes: 7.9\n").web_terminal?.ttl_minutes).toBe(7);
  });

  it("M2: a quoted or numeric `enabled` is rejected — a security gate must be a real boolean", () => {
    expect(() => load("defaults: {}\ninstances: {}\nweb_terminal:\n  enabled: \"false\"\n")).toThrow(/web_terminal\.enabled/);
    expect(() => load("defaults: {}\ninstances: {}\nweb_terminal:\n  enabled: 0\n")).toThrow(/web_terminal\.enabled/);
    expect(load("defaults: {}\ninstances: {}\nweb_terminal:\n  enabled: false\n").web_terminal?.enabled).toBe(false);
  });

  it("M2: login / web_terminal must be mappings", () => {
    expect(() => load("defaults: {}\ninstances: {}\nlogin: web\n")).toThrow(/login: expected a mapping/);
    expect(() => load("defaults: {}\ninstances: {}\nweb_terminal: true\n")).toThrow(/web_terminal: expected a mapping/);
  });

  it("rejects an unknown login.mode and a non-numeric ttl or empty bind", () => {
    expect(() => load("defaults: {}\ninstances: {}\nlogin:\n  mode: tunnel\n")).toThrow(/login\.mode/);
    expect(() => load("defaults: {}\ninstances: {}\nweb_terminal:\n  ttl_minutes: soon\n")).toThrow(/ttl_minutes/);
    expect(() => load("defaults: {}\ninstances: {}\nweb_terminal:\n  bind: ''\n")).toThrow(/bind/);
  });
});

describe("web_terminal.tunnel config", () => {
  const withTunnel = (body: string) => `defaults: {}\ninstances: {}\nweb_terminal:\n  tunnel:\n${body}\n`;

  it("is absent by default — nothing is ever offered unless it is configured", () => {
    expect(load("defaults: {}\ninstances: {}\nweb_terminal:\n  enabled: true\n").web_terminal?.tunnel).toBeUndefined();
  });

  it("parses a full block", () => {
    const cfg = load(withTunnel("    provider: cloudflared\n    allow_public: true\n    protocol: quic"));
    expect(cfg.web_terminal?.tunnel).toEqual({ provider: "cloudflared", allow_public: true, protocol: "quic" });
  });

  it("allow_public must be a real boolean: a quoted \"false\" would read as truthy", () => {
    expect(() => load(withTunnel("    allow_public: \"false\""))).toThrow(/allow_public: expected true or false/);
    expect(() => load(withTunnel("    allow_public: 1"))).toThrow(/allow_public: expected true or false/);
  });

  it("refuses an unknown key, so a misspelt switch cannot silently do nothing", () => {
    expect(() => load(withTunnel("    allow_publc: true"))).toThrow(/web_terminal\.tunnel\.allow_publc: unknown key/);
  });

  it("refuses an unsupported provider or protocol, and a non-mapping", () => {
    expect(() => load(withTunnel("    provider: ngrok"))).toThrow(/provider: only "cloudflared"/);
    expect(() => load(withTunnel("    protocol: udp"))).toThrow(/protocol: expected http2, quic or auto/);
    expect(() => load("defaults: {}\ninstances: {}\nweb_terminal:\n  tunnel: true\n")).toThrow(/web_terminal\.tunnel: expected a mapping/);
  });
});
