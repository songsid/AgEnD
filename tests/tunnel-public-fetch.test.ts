import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PUBLIC_RESOLVERS, fetchViaPublicResolver, isPublicIPv4, type ProbeResponse } from "../src/tunnel/public-fetch.js";

const URL_ = "https://calm-river-1.trycloudflare.com/t/abc/";
const ok = (body = "page"): ProbeResponse => ({ status: 200, contentType: "text/html", body });

/** A fake `https.request`: records the options and answers with a canned response. */
function fakeRequest(reply: { status?: number; type?: string; body?: string; error?: Error }) {
  const calls: Array<Record<string, unknown>> = [];
  const request = ((options: Record<string, unknown>, cb: (res: unknown) => void) => {
    calls.push(options);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(err?: Error): void };
    req.destroy = (err?: Error) => { if (err) req.emit("error", err); };
    req.end = () => {
      if (reply.error) { queueMicrotask(() => req.emit("error", reply.error)); return; }
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      res.statusCode = reply.status ?? 200;
      res.headers = { "content-type": reply.type ?? "text/html" };
      cb(res);
      queueMicrotask(() => { res.emit("data", Buffer.from(reply.body ?? "page")); res.emit("end"); });
    };
    return req;
  }) as never;
  return { request, calls };
}

describe("the readiness probe asks a public resolver and connects by address", () => {
  it("connects to the resolved address with the tunnel hostname as SNI and Host", async () => {
    const { request, calls } = fakeRequest({ body: "agend-terminal:abc" });
    const res = await fetchViaPublicResolver(URL_, new AbortController().signal, {
      resolve4: async host => { expect(host).toBe("calm-river-1.trycloudflare.com"); return ["104.16.230.132"]; },
      request,
      fallback: async () => { throw new Error("fallback must not run"); },
    });
    expect(res).toEqual({ status: 200, contentType: "text/html", body: "agend-terminal:abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: "104.16.230.132", port: 443, method: "GET", path: "/t/abc/",
      servername: "calm-river-1.trycloudflare.com",
      headers: { host: "calm-river-1.trycloudflare.com" },
    });
  });

  it("never turns certificate verification off", async () => {
    const { request, calls } = fakeRequest({});
    await fetchViaPublicResolver(URL_, new AbortController().signal, {
      resolve4: async () => ["104.16.230.132"], request, fallback: async () => ok(),
    });
    expect(calls[0]).not.toHaveProperty("rejectUnauthorized");
    expect(calls[0]).not.toHaveProperty("checkServerIdentity");
  });

  it("uses Cloudflare's resolvers by default", () => {
    expect([...PUBLIC_RESOLVERS]).toEqual(["1.1.1.1", "1.0.0.1"]);
  });

  it("does not read a body unless the status is 200", async () => {
    const { request } = fakeRequest({ status: 403, body: "forbidden" });
    const res = await fetchViaPublicResolver(URL_, new AbortController().signal, {
      resolve4: async () => ["104.16.230.132"], request, fallback: async () => ok(),
    });
    expect(res).toEqual({ status: 403, contentType: "text/html", body: "" });
  });

  it("reports a connection failure rather than quietly trying another way", async () => {
    const { request } = fakeRequest({ error: new Error("tls: certificate does not match") });
    await expect(fetchViaPublicResolver(URL_, new AbortController().signal, {
      resolve4: async () => ["104.16.230.132"], request,
      fallback: async () => { throw new Error("fallback must not run after a resolved connection failed"); },
    })).rejects.toThrow("certificate does not match");
  });
});

describe("the system resolver is the fallback, not a parallel path", () => {
  const signal = new AbortController().signal;
  const never = fakeRequest({}).request;

  it("when the public resolver errors", async () => {
    const res = await fetchViaPublicResolver(URL_, signal, {
      resolve4: async () => { throw new Error("ETIMEOUT"); }, request: never, fallback: async () => ok("via system"),
    });
    expect(res.body).toBe("via system");
  });

  it("when it returns nothing", async () => {
    const res = await fetchViaPublicResolver(URL_, signal, { resolve4: async () => [], request: never, fallback: async () => ok("via system") });
    expect(res.body).toBe("via system");
  });

  it("when it returns only addresses that cannot be an edge", async () => {
    for (const bad of ["127.0.0.1", "10.0.0.5", "192.168.1.9", "169.254.1.1", "172.16.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      const { request, calls } = fakeRequest({});
      const res = await fetchViaPublicResolver(URL_, signal, { resolve4: async () => [bad], request, fallback: async () => ok("via system") });
      expect(res.body, bad).toBe("via system");
      expect(calls, bad).toHaveLength(0);
    }
  });

  it("skips a private address and takes the first public one", async () => {
    const { request, calls } = fakeRequest({});
    await fetchViaPublicResolver(URL_, signal, { resolve4: async () => ["10.0.0.5", "104.16.230.132"], request, fallback: async () => ok() });
    expect(calls[0]!.host).toBe("104.16.230.132");
  });

  it("when the public path is switched off, or the URL is not https", async () => {
    const { request, calls } = fakeRequest({});
    const off = await fetchViaPublicResolver(URL_, signal, { resolvers: [], resolve4: async () => ["104.16.230.132"], request, fallback: async () => ok("via system") });
    const plain = await fetchViaPublicResolver("http://calm-river-1.trycloudflare.com/", signal, { resolve4: async () => ["104.16.230.132"], request, fallback: async () => ok("via system") });
    expect(off.body).toBe("via system");
    expect(plain.body).toBe("via system");
    expect(calls).toHaveLength(0);
  });
});

describe("isPublicIPv4", () => {
  it("accepts ordinary public addresses and refuses everything else", () => {
    for (const good of ["1.1.1.1", "104.16.230.132", "172.67.1.1", "8.8.8.8"]) expect(isPublicIPv4(good), good).toBe(true);
    for (const bad of ["", "not-an-ip", "::1", "300.1.1.1", "255.255.255.255", "172.32.0.1x"]) expect(isPublicIPv4(bad), bad).toBe(false);
    expect(isPublicIPv4("172.32.0.1")).toBe(true);   // just outside 172.16/12
    expect(isPublicIPv4("100.128.0.1")).toBe(true);  // just outside CGNAT 100.64/10
  });
});
