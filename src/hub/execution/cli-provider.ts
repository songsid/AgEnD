/** Reviewed local Linux Docker boundary; no normal fleet/CLI delivery driver is used. */
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { lstatSync } from "node:fs";
import { execFile, spawn } from "../../child-process.js";
import { z } from "zod";
import { HubProtocolError, parseStrictJson, plain, uuid, validated } from "../validation.js";
import type { HubExecutionGateway, HubIsolatedProvider } from "./service.js";
import { HubProviderSetupError } from "./provider-setup.js";
import { documentArguments, documentTool, HubForbiddenModelTool, MODEL_WIRE_LIMIT, restrictedModelRequest, validateModelReply,
  type HubCliBackend, type HubModelBroker } from "./model-broker.js";

const run = promisify(execFile);
const cliEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
export const HUB_PROVIDER_CLI_VERSIONS = Object.freeze({ claude: "2.1.316", codex: "0.166.0" });
export interface HubCliProviderOptions {
  backend: HubCliBackend;
  /** Immutable LOCAL image ID, never a tag or remote ref. No runtime pull. */
  imageId: string;
  model: string;
  modelBroker: HubModelBroker;
  /** A local Unix socket only. No Docker environment/context or remote daemon is inherited. */
  dockerSocket?: string;
}
export interface HubCliProvider extends HubIsolatedProvider { close(): Promise<void> }
const object = (v: unknown) => z.record(z.string(), z.unknown()).parse(v);
const includesPrompt = (v: unknown, prompt: string): boolean => typeof v === "string" ? v.includes(prompt)
  : Array.isArray(v) ? v.some(x => includesPrompt(x, prompt))
  : !!v && typeof v === "object" && Object.values(v).some(x => includesPrompt(x, prompt));

export function hubContainerArguments(imageId: string, name: string, token: string, contextId: string): string[] {
  return ["create", "--pull=never", "--name", name, "--label", `org.agend.hub.question=${token}`,
    "--label", `org.agend.hub.context=${contextId}`,
    "--network=none", "--read-only", "--log-driver=none", "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--memory=1073741824", "--memory-swap=1073741824", "--cpus=1", "--pids-limit=64", "--ulimit", "nofile=128:128",
    "--tmpfs", "/scratch:rw,nosuid,nodev,noexec,size=67108864,mode=1777", "--workdir=/scratch", "--init", "--interactive",
    "--entrypoint=/usr/local/bin/node", imageId, "/opt/agend/sandbox-runner.js"];
}
/** Check actual engine state, not just the command that requested isolation. */
export function verifyHubContainer(value: unknown, imageId: string, token: string, contextId?: string): void {
  const c = object(value), h = object(c.HostConfig), config = object(c.Config), tmpfs = object(h.Tmpfs);
  const security = z.array(z.string()).parse(h.SecurityOpt), caps = z.array(z.string()).parse(h.CapDrop);
  if (c.Image !== imageId || config.User !== "65532:65532" || object(config.Labels)["org.agend.hub.question"] !== token
    || contextId !== undefined && object(config.Labels)["org.agend.hub.context"] !== contextId
    || config.WorkingDir !== "/scratch" || JSON.stringify(config.Entrypoint) !== JSON.stringify(["/usr/local/bin/node"])
    || JSON.stringify(config.Cmd) !== JSON.stringify(["/opt/agend/sandbox-runner.js"])
    || h.NetworkMode !== "none" || h.ReadonlyRootfs !== true || h.Privileged !== false || h.Init !== true || object(h.LogConfig).Type !== "none"
    || h.Memory !== 1073741824 || h.MemorySwap !== 1073741824 || h.NanoCpus !== 1_000_000_000 || h.PidsLimit !== 64
    || !caps.includes("ALL") || !security.some(s => s === "no-new-privileges:true" || s === "no-new-privileges")
    || (Array.isArray(h.CapAdd) && h.CapAdd.length) || h.PidMode || h.IpcMode === "host" || h.UTSMode === "host"
    || (Array.isArray(c.Mounts) && c.Mounts.length) || (Array.isArray(h.Binds) && h.Binds.length)
    || (Array.isArray(h.Devices) && h.Devices.length) || (Array.isArray(h.DeviceRequests) && h.DeviceRequests.length)
    || Object.keys(object(h.PortBindings ?? {})).length || Object.keys(tmpfs).length !== 1
    || typeof tmpfs["/scratch"] !== "string" || !tmpfs["/scratch"].includes("size=67108864")
    || !["nosuid", "nodev", "noexec"].every(s => (tmpfs["/scratch"] as string).split(",").includes(s))) throw new HubProtocolError("incompatible");
}

/** Explicit async availability check; merely importing this module cannot install or start anything. */
export async function createHubCliProvider(options: HubCliProviderOptions): Promise<HubCliProvider> {
  const backend = z.enum(["claude", "codex"]).parse(options.backend);
  const selectedImage = z.string().regex(/^sha256:[a-f0-9]{64}$/).safeParse(options.imageId);
  if (!selectedImage.success) throw new HubProviderSetupError("image-unconfigured");
  const imageId = selectedImage.data;
  const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/).parse(options.model);
  const selectedSocket = z.string().regex(/^\/(?:var\/run|run)\/[a-zA-Z0-9/_.-]+\.sock$/).safeParse(options.dockerSocket ?? "/var/run/docker.sock");
  if (!selectedSocket.success || selectedSocket.data.split("/").some(part => part === "." || part === "..")) throw new HubProviderSetupError("engine-unavailable");
  const socket = selectedSocket.data;
  try { if (!lstatSync(socket).isSocket()) throw new Error(); }
  catch { throw new HubProviderSetupError("engine-unavailable"); }
  const modelBroker = options.modelBroker;
  if (typeof modelBroker !== "function") throw new HubProviderSetupError("credential-unconfigured");
  const docker = ["--host", `unix://${socket}`];
  const command = async (args: string[]): Promise<string> => {
    try { return (await run("docker", [...docker, ...args], { env: cliEnv, timeout: 10_000, maxBuffer: MODEL_WIRE_LIMIT })).stdout.trim(); }
    catch { throw new HubProtocolError("unavailable"); }
  };
  let engine: string;
  try { engine = await command(["info", "--format", "{{.OSType}}/{{.Architecture}}"]); }
  catch { throw new HubProviderSetupError("engine-unavailable"); }
  if (!/^linux\/(?:amd64|x86_64)$/.test(engine)) throw new HubProviderSetupError("engine-unsupported");
  try {
    const images = z.array(z.unknown()).length(1).parse(parseStrictJson(await command(["image", "inspect", imageId]), MODEL_WIRE_LIMIT));
    const image = object(images[0]), config = object(image.Config), labels = object(config.Labels);
    if (image.Id !== imageId || image.Architecture !== "amd64" || labels["org.agend.hub.protocol"] !== "1" || labels[`org.agend.hub.${backend}`] !== HUB_PROVIDER_CLI_VERSIONS[backend]
      || (config.Volumes && Object.keys(object(config.Volumes)).length) || (config.OnBuild && (config.OnBuild as unknown[]).length)) throw new Error();
  } catch { throw new HubProviderSetupError("image-mismatch"); }
  let poisoned = false, active = 0, stopped = false;
  const sessions = new Set<() => Promise<void>>();
  return {
    get isolation() { if (poisoned || stopped) throw new HubProtocolError("unavailable"); return "hub-restricted-v1" as const; },
    async close() { stopped = true; const results = await Promise.allSettled([...sessions].map(close => close())); if (results.some(r => r.status === "rejected")) throw new HubProtocolError("uncertain"); },
    async open(input) {
      if (poisoned || stopped || active >= 8 || input.signal.aborted) throw new HubProtocolError("unavailable");
      validated(uuid, input.contextId); validated(plain(32 * 1024), input.question); validated(plain(4096), input.label);
      active++;
      const token = randomUUID(), name = `agend-hub-question-${token}`, abort = new AbortController();
      const prompt = `${input.label}\nContext: ${input.contextId}\n\n${input.question}`;
      let container: string | undefined, child: ReturnType<typeof spawn> | undefined, closed: Promise<void> | undefined;
      let creation: Promise<string> | undefined;
      const work = new Set<Promise<void>>();
      let accepted = false, answerReceived = false, busy = false, apiCalls = 0, toolCalls = 0, bytes = 0;
      let exited!: (code: number | null) => void;
      const exit = new Promise<number | null>(resolve => { exited = resolve; });
      let gateway: HubExecutionGateway | undefined, releaseGateway!: () => void;
      const gatewayReady = new Promise<void>(resolve => { releaseGateway = resolve; });
      let accept!: () => void, rejectAccept!: (e: unknown) => void, answer!: (text: string) => void, rejectAnswer!: (e: unknown) => void;
      const admission = new Promise<void>((resolve, reject) => { accept = resolve; rejectAccept = reject; });
      const result = new Promise<string>((resolve, reject) => { answer = resolve; rejectAnswer = reject; });
      void admission.catch(() => {}); void result.catch(() => {});
      const fail = () => { const error = new HubProtocolError("uncertain"); rejectAccept(error); rejectAnswer(error); releaseGateway(); abort.abort(); };
      const close = (): Promise<void> => {
        if (closed) return closed;
        let resolve!: () => void, reject!: (error: unknown) => void;
        const attempt = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        closed = attempt;
        fail();
        void (async () => {
          let failed = false;
          try {
            if (creation) {
              try { container ??= await creation; } catch { /* Inspect the owned name after an ambiguous create. */ }
              const knownId = container && /^[a-f0-9]{64}$/.test(container) ? container : undefined;
              // A lost rm response can mean removal succeeded. Confirm absence by exact immutable ID, never by label alone.
              const listed = knownId ? await command(["container", "ls", "--all", "--no-trunc", "--filter", `id=${knownId}`, "--format", "{{.ID}}"]) : undefined;
              if (listed && listed !== knownId) throw new HubProtocolError("uncertain");
              if (listed !== "") {
                // The random name is ours even when create returned an ambiguous outcome. Inspect ownership before removal.
                const rows = z.array(z.unknown()).length(1).parse(parseStrictJson(await command(["container", "inspect", knownId ?? name])));
                const c = object(rows[0]);
                if (object(object(c.Config).Labels)["org.agend.hub.question"] !== token || typeof c.Id !== "string" || !/^[a-f0-9]{64}$/.test(c.Id)) throw new HubProtocolError("uncertain");
                container = c.Id;
                await command(["rm", "--force", container]);
              }
            }
          } catch { failed = true; poisoned = true; }
          finally {
            // Failed removal still owns pending broker/tool work. Abort prevents dispatch; draining proves it exited.
            child?.kill();
            await Promise.allSettled([...work]);
            try {
              if (child) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HubProtocolError("uncertain")), 5_000); })]); }
                finally { clearTimeout(timer); }
              }
            } catch { failed = true; poisoned = true; }
            finally {
              clearTimeout(deadline); input.signal.removeEventListener("abort", onAbort);
              if (!failed) { active--; sessions.delete(close); }
            }
          }
          if (failed) throw new HubProtocolError("uncertain");
        })().then(resolve, error => { closed = undefined; reject(error); });
        return attempt;
      };
      const onAbort = () => { void close().catch(() => {}); };
      const deadline = setTimeout(onAbort, 120_000); deadline.unref();
      sessions.add(close);
      input.signal.addEventListener("abort", onAbort, { once: true });
      const send = (message: unknown) => {
        if (abort.signal.aborted || !child?.stdin?.writable) throw new HubProtocolError("stale");
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const message = async (raw: string): Promise<void> => {
        if (abort.signal.aborted || busy) throw new HubProtocolError("uncertain");
        busy = true;
        try {
          const frame = object(parseStrictJson(raw, 2 * MODEL_WIRE_LIMIT));
          if (frame.type === "model") {
            const id = z.number().int().min(1).max(256).parse(frame.id);
            if (++apiCalls > 16) throw new HubProtocolError("backpressure");
            const request = restrictedModelRequest(backend, model, frame.body);
            if (!accepted) {
              if (!includesPrompt(backend === "claude" ? request.messages : request.input, prompt)) throw new HubProtocolError("uncertain");
              accepted = true; accept();
            }
            await gatewayReady;
            if (abort.signal.aborted || !gateway) throw new HubProtocolError("stale");
            let reply;
            try { reply = validateModelReply(backend, await modelBroker(backend, request, abort.signal)); }
            catch (error) {
              if (error instanceof HubForbiddenModelTool && !abort.signal.aborted) await gateway.propose(error.tool, error.args, "The restricted session refused this tool. Local review is required; no action was executed.");
              throw error;
            }
            if (abort.signal.aborted) throw new HubProtocolError("stale");
            send({ type: "model-result", id, ...reply });
          } else if (frame.type === "tool") {
            if (!accepted || !gateway || ++toolCalls > 64) throw new HubProtocolError("denied");
            const id = z.number().int().min(1).max(256).parse(frame.id), name = documentTool(z.string().parse(frame.name));
            const args = documentArguments(name, frame.arguments), value = await gateway.invoke(name, args);
            if (abort.signal.aborted) throw new HubProtocolError("stale");
            const text = JSON.stringify(value); if (Buffer.byteLength(text) > 128 * 1024) throw new HubProtocolError("backpressure");
            send({ type: "tool-result", id, text });
          } else if (frame.type === "answer") {
            if (!accepted || !gateway || answerReceived) throw new HubProtocolError("uncertain");
            answerReceived = true;
            const text = validated(plain(128 * 1024), frame.text);
            const response = validated(z.strictObject({ answer: plain(120 * 1024), proposal: z.strictObject({ action: plain(256).min(1), arguments: z.unknown(), consequences: plain(4096).min(1) }).nullable() }), parseStrictJson(text, 128 * 1024));
            if (response.proposal) await gateway.propose(response.proposal.action, response.proposal.arguments, response.proposal.consequences);
            if (abort.signal.aborted) throw new HubProtocolError("stale");
            answer(response.answer);
          } else throw new HubProtocolError("uncertain");
        } finally { busy = false; }
      };
      try {
        if (input.signal.aborted) throw new HubProtocolError("stale");
        creation = command(hubContainerArguments(imageId, name, token, input.contextId));
        container = await creation;
        if (!/^[a-f0-9]{64}$/.test(container) || abort.signal.aborted) throw new HubProtocolError("uncertain");
        const rows = z.array(z.unknown()).length(1).parse(parseStrictJson(await command(["container", "inspect", container])));
        verifyHubContainer(rows[0], imageId, token, input.contextId);
        if (abort.signal.aborted) throw new HubProtocolError("stale");
        child = spawn("docker", [...docker, "start", "--attach", "--interactive", container], { env: cliEnv, stdio: ["pipe", "pipe", "pipe"] });
        let buffer = "";
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk); buffer += chunk;
          if (bytes > 8 * MODEL_WIRE_LIMIT || Buffer.byteLength(buffer) > 2 * MODEL_WIRE_LIMIT) { onAbort(); return; }
          for (;;) {
            const at = buffer.indexOf("\n"); if (at < 0) break;
            const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            const pending = Promise.resolve().then(() => message(line)); work.add(pending);
            void pending.finally(() => work.delete(pending)).catch(onAbort);
          }
        });
        let stderrBytes = 0;
        child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) onAbort(); });
        child.on("error", onAbort);
        child.on("close", code => { exited(code); if (code !== 0 || !answerReceived) onAbort(); });
        input.beforeInput();
        if (abort.signal.aborted) throw new HubProtocolError("stale");
        send({ type: "start", backend, model, prompt });
        await admission;
        if (abort.signal.aborted) throw new HubProtocolError("stale");
        let answering = false;
        return {
          async answer(scopedGateway) {
            if (answering || abort.signal.aborted) throw new HubProtocolError("stale");
            answering = true; gateway = scopedGateway; releaseGateway();
            let text: string;
            try { text = await result; if (await exit !== 0) throw new HubProtocolError("uncertain"); }
            catch { await close(); throw new HubProtocolError("uncertain"); }
            await close(); return text;
          }, close,
        };
      } catch { await close(); throw new HubProtocolError("uncertain"); }
    },
  };
}
