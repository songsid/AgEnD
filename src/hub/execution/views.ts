/** P1 data tools read an owner-approved immutable snapshot, never a path, URL or SQL string. */
import { z } from "zod";
import { canonicalArguments, sha256 } from "../identity.js";
import { identifier, plain, validated, HubProtocolError } from "../validation.js";

export const HUB_READ_TOOLS = ["documents.list", "documents.read"] as const;
const documentSchema = z.strictObject({ id: identifier, title: plain(256), text: plain(64 * 1024) });
export type HubViewDocument = z.infer<typeof documentSchema>;
const views = new WeakSet<object>();

export class HubDocumentView {
  readonly digest: string;
  private readonly documents: readonly HubViewDocument[];
  constructor(readonly id: string, documents: readonly HubViewDocument[]) {
    validated(identifier, id);
    this.documents = validated(z.array(documentSchema).max(64), documents).map(d => Object.freeze(d));
    if (new Set(this.documents.map(d => d.id)).size !== this.documents.length) throw new HubProtocolError();
    const bytes = canonicalArguments(this.documents);
    this.digest = sha256(bytes); views.add(this); Object.freeze(this.documents); Object.freeze(this);
  }
  static installed(view: unknown): view is HubDocumentView { return !!view && typeof view === "object" && views.has(view); }
  arguments(name: string, input: unknown): unknown {
    if (name === "documents.list") return validated(z.strictObject({}), input);
    if (name === "documents.read") return validated(z.strictObject({ documentId: identifier }), input);
    throw new HubProtocolError("denied");
  }
  read(name: string, input: unknown): unknown {
    const args = this.arguments(name, input);
    if (name === "documents.list") return this.documents.map(({ id, title }) => ({ id, title }));
    const document = this.documents.find(d => d.id === (args as { documentId: string }).documentId);
    if (!document) throw new HubProtocolError("denied");
    return { ...document };
  }
}

export function executionPolicyDigest(view: HubDocumentView, allowedTools: readonly string[]): string {
  if (!HubDocumentView.installed(view) || allowedTools.length > 2 || new Set(allowedTools).size !== allowedTools.length
    || !allowedTools.every(name => HUB_READ_TOOLS.includes(name as typeof HUB_READ_TOOLS[number]))) throw new HubProtocolError("denied");
  return sha256(canonicalArguments(["agend-hub-read-policy-v1", view.id, view.digest, [...allowedTools].sort(), true]));
}
