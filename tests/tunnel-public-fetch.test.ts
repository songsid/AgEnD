import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MAX_PROBE_BODY, PUBLIC_RESOLVERS, fetchViaPublicResolver, fetchViaSystemResolver, isPublicIPv4, type ProbeResponse } from "../src/tunnel/public-fetch.js";

const URL_ = "https://calm-river-1.trycloudflare.com/t/abc/";
const ok = (body = "page"): ProbeResponse => ({ status: 200, contentType: "text/html", body });

/** A fake `https.request`: records the options and answers with a canned response. */
function fakeRequest(reply: { status?: number; type?: string; body?: string; error?: Error }) {
  const calls: Array<Record<string, unknown>> = [];
  const responses: Array<EventEmitter & { resume: ReturnType<typeof vi.fn> }> = [];
  const request = ((options: Record<string, unknown>, cb: (res: unknown) => void) => {
    calls.push(options);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(err?: Error): void };
    req.destroy = (err?: Error) => { if (err) req.emit("error", err); };
    req.end = () => {
      if (reply.error) { queueMicrotask(() => req.emit("error", reply.error)); return; }
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; resume: ReturnType<typeof vi.fn> };
      res.statusCode = reply.status ?? 200;
      res.headers = { "content-type": reply.type ?? "text/html" };
      res.resume = vi.fn();
      responses.push(res);
      cb(res);
      // A real response only emits "data" to someone who is reading it.
      queueMicrotask(() => { if (res.listenerCount("data") > 0) res.emit("data", Buffer.from(reply.body ?? "page")); res.emit("end"); });
    };
    return req;
  }) as never;
  return { request, calls, responses };
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

  it("does not collect a body unless the status is 200 — it is discarded as it arrives", async () => {
    const { request, responses } = fakeRequest({ status: 403, body: "forbidden" });
    const res = await fetchViaPublicResolver(URL_, new AbortController().signal, {
      resolve4: async () => ["104.16.230.132"], request, fallback: async () => ok(),
    });
    expect(res).toEqual({ status: 403, contentType: "text/html", body: "" });
    expect(responses[0]!.resume).toHaveBeenCalled();
    expect(responses[0]!.listenerCount("data")).toBe(0);          // nothing was reading it into memory
  });

  it("accepts exactly the cap and refuses one byte more", async () => {
    const run = async (size: number) => {
      const { request } = fakeRequest({ body: "x".repeat(size) });
      return fetchViaPublicResolver(URL_, new AbortController().signal, {
        resolve4: async () => ["104.16.230.132"], request, fallback: async () => ok(),
      });
    };
    expect((await run(MAX_PROBE_BODY)).body).toHaveLength(MAX_PROBE_BODY);
    await expect(run(MAX_PROBE_BODY + 1)).rejects.toThrow("too large");
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

describe("the system-resolver path is bounded exactly like the public one", () => {
  const signal = new AbortController().signal;
  const page = (body: string | Uint8Array, init: ResponseInit = { status: 200, headers: { "content-type": "text/html" } }) =>
    (async () => new Response(body as never, init)) as unknown as typeof fetch;

  it("returns a normal page", async () => {
    expect(await fetchViaSystemResolver("https://x.trycloudflare.com/", signal, page("hello"))).toEqual({ status: 200, contentType: "text/html", body: "hello" });
  });

  it("accepts exactly the cap and refuses one byte more", async () => {
    expect((await fetchViaSystemResolver("https://x.trycloudflare.com/", signal, page("x".repeat(MAX_PROBE_BODY)))).body).toHaveLength(MAX_PROBE_BODY);
    await expect(fetchViaSystemResolver("https://x.trycloudflare.com/", signal, page("x".repeat(MAX_PROBE_BODY + 1)))).rejects.toThrow("too large");
  });

  it("stops reading an endless body at the cap rather than buffering it", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(64 * 1024)); } });
    await expect(fetchViaSystemResolver("https://x.trycloudflare.com/", signal, page(endless as never))).rejects.toThrow("too large");
    expect(pulled).toBeLessThan(MAX_PROBE_BODY / (64 * 1024) + 4);
  });

  it("does not read a non-200 body, and does not follow redirects", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); } });
    const seen: RequestInit[] = [];
    const impl = (async (_u: string, init?: RequestInit) => { seen.push(init ?? {}); return new Response(body, { status: 502, headers: { "content-type": "text/html" } }); }) as unknown as typeof fetch;
    expect(await fetchViaSystemResolver("https://x.trycloudflare.com/", signal, impl)).toEqual({ status: 502, contentType: "text/html", body: "" });
    expect(pulled).toBeLessThanOrEqual(1);
    expect(seen[0]).toMatchObject({ redirect: "manual", cache: "no-store" });
  });
});
