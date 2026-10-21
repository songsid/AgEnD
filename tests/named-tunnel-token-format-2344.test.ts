import { describe, expect, it } from "vitest";
import { normalizePublicTunnelToken, validPublicTunnelToken } from "../src/public-tunnel-config.js";
import { syntheticTunnelFields, syntheticTunnelToken } from "./helpers/named-tunnel-token.js";

describe("named tunnel credential shape (no remote authentication)", () => {
  it("accepts Cloudflare's account/UUID/base64-secret JSON and optional endpoint", () => {
    const token = syntheticTunnelToken();
    expect(validPublicTunnelToken(token)).toBe(true);
    expect(normalizePublicTunnelToken(token)).toBe(token);
    expect(validPublicTunnelToken(syntheticTunnelToken({ ...syntheticTunnelFields(), e: "region.example.com" }))).toBe(true);
  });
  it.each([" \n%s\t", ' "%s" ', "\t'%s'\n", '"  %s  "'])("trims only whitespace and a matching pair of surrounding quotes: %s", wrapper => {
    const token = syntheticTunnelToken();
    expect(normalizePublicTunnelToken(wrapper.replace("%s", token))).toBe(token);
  });
  it("canonicalizes base64url and missing padding for cloudflared's standard-base64 decoder", () => {
    // The Unicode endpoint makes the two alphabets differ; this is local shape validation only.
    const fields = { ...syntheticTunnelFields(), e: "\uffff" };
    const standard = syntheticTunnelToken(fields);
    const url = syntheticTunnelToken(fields, "base64url");
    expect(url).not.toBe(standard.replace(/=+$/, ""));
    expect(normalizePublicTunnelToken(url)).toBe(standard);
    expect(normalizePublicTunnelToken(standard.replace(/=+$/, ""))).toBe(standard);
  });
  it.each(["cloudflared.exe service install %s", "cloudflared tunnel run --token %s", "--token %s", "--token=%s", "'%s\"", "%s extra", "%s\n%s"])("refuses command, prefix or multiple-token input without extracting credentials: %s", wrapper => {
    expect(normalizePublicTunnelToken(wrapper.replaceAll("%s", syntheticTunnelToken()))).toBeNull();
  });
  it.each(["not JSON, just some bytes", "null", "[]", "42", '"not an object"'])("refuses decoded non-object JSON/input: %s", text => {
    expect(validPublicTunnelToken(Buffer.from(text).toString("base64"))).toBe(false);
  });
  it.each(["a", "t", "s"])("requires tunnel field %s", key => {
    const fields: Record<string, unknown> = syntheticTunnelFields(); delete fields[key];
    expect(normalizePublicTunnelToken(syntheticTunnelToken(fields))).toBeNull();
  });
  it.each([{ a: null }, { a: " " }, { t: 1 }, { t: "not-a-tunnel-uuid" }, { s: [] }, { s: "" }, { s: "not!base64" }, { e: {} }])("refuses incorrect field types and encodings: %j", patch => {
    expect(validPublicTunnelToken(syntheticTunnelToken({ ...syntheticTunnelFields(), ...patch }))).toBe(false);
  });
  it("rejects short/long input, bad padding, internal whitespace, invalid UTF-8 and non-string values", () => {
    const token = syntheticTunnelToken();
    const malformed = ["", "eyJ", "x".repeat(4097), " ".repeat(4097) + token, token + "===", token.slice(0, 20) + "\n" + token.slice(20), Buffer.concat([Buffer.from('{"a":"'), Buffer.from([255]), Buffer.from('"}')]).toString("base64"), undefined, {}];
    for (const input of malformed) expect(normalizePublicTunnelToken(input)).toBeNull();
    // Exercise the upper bound on otherwise well-shaped credentials, not just invalid garbage.
    expect(normalizePublicTunnelToken(syntheticTunnelToken({ ...syntheticTunnelFields(), e: "x".repeat(4096) }))).toBeNull();
  });
  it("does not silently strip a decoded UTF-8 BOM that cloudflared's JSON parser would reject", () => {
    const token = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(JSON.stringify(syntheticTunnelFields()))]).toString("base64");
    expect(normalizePublicTunnelToken(token)).toBeNull();
  });
});
