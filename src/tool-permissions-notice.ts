/**
 * What to tell an operator whose fleet predates the `worker` default.
 *
 * Two things can be true of an existing installation and neither of them is
 * something to fix on the operator's behalf:
 *
 * - `defaults.tool_set: full` may be written in their `fleet.yaml`, in which
 *   case the new code default never applies and every worker still holds the
 *   whole toolbox. Rewriting that line would be a surprise placed inside their
 *   own file.
 * - Some instances really are coordinating, and marking them is a judgement
 *   about how their fleet is organised.
 *
 * So this computes the advice and says it once, naming the instances that will
 * actually break rather than the ones that merely look like coordinators. A
 * notice that asks someone to mark twenty instances they did not need to mark
 * is a notice they stop reading.
 */
import { mayUseTool, resolveToolSet, type ToolSetName } from "./tool-permissions.js";

export interface InstanceToolUse {
  readonly instance: string;
  /** Tool name → how many times this instance called it. */
  readonly tools: ReadonlyMap<string, number>;
}

export interface NoticeInput {
  readonly defaultsToolSet?: string;
  readonly instances: Readonly<Record<string, { tool_set?: string; general_topic?: boolean }>>;
  /** Recent tool use, from the activity log. Empty is a valid answer. */
  readonly recent: readonly InstanceToolUse[];
}

export interface CoordinatorCandidate {
  readonly instance: string;
  /** Only the tools the new profile would refuse, most-used first. */
  readonly refusedTools: ReadonlyArray<readonly [string, number]>;
}

/**
 * Which instances would lose something they have actually been using.
 *
 * The rule is "called a tool the resolved profile refuses" — that is the
 * definition of breaking, not a guess at intent. An instance that only ever
 * called `delegate_task` does not appear, because `delegate_task` stays with
 * the worker and nothing about it changes.
 */
export function coordinatorCandidates(input: NoticeInput): CoordinatorCandidate[] {
  const out: CoordinatorCandidate[] = [];
  for (const use of input.recent) {
    // The activity log outlives the config. An instance that has since been
    // deleted resolves to `worker` like any other unknown name, and would be
    // named in a list of things to go and edit that no longer exist.
    if (!Object.hasOwn(input.instances, use.instance)) continue;
    const config = input.instances[use.instance];
    // An instance that is already explicitly widened, or is a general, is not
    // about to lose anything.
    const profile: ToolSetName = resolveToolSet(config, use.instance);
    const refused = [...use.tools.entries()]
      .filter(([tool]) => !mayUseTool(profile, tool))
      .sort((a, b) => b[1] - a[1]);
    if (refused.length > 0) out.push({ instance: use.instance, refusedTools: refused });
  }
  return out.sort((a, b) =>
    b.refusedTools.reduce((n, [, c]) => n + c, 0) - a.refusedTools.reduce((n, [, c]) => n + c, 0));
}

/** True when this fleet asked for `full` out loud, so the new default cannot reach it. */
export function hasExplicitFullDefault(input: NoticeInput): boolean {
  return input.defaultsToolSet === "full";
}

export function instancesExplicitlyFull(input: NoticeInput): string[] {
  return Object.entries(input.instances)
    .filter(([, config]) => config?.tool_set === "full")
    .map(([name]) => name)
    .sort();
}

/**
 * The whole notice, or null when there is nothing worth saying.
 *
 * One message rather than two: an operator who needs to hear both hears them
 * together, in the order they have to act on them.
 */
export function buildToolPermissionsNotice(input: NoticeInput): string | null {
  const lines: string[] = [];
  const explicitFull = hasExplicitFullDefault(input);
  const alsoFull = instancesExplicitlyFull(input);
  const candidates = coordinatorCandidates(input);

  if (explicitFull) {
    lines.push(
      "Your fleet.yaml sets `defaults.tool_set: full`, so every agent still gets all of AgEnD's tools —",
      "including create_instance, delete_instance and update_fleet_defaults. AgEnD's own default is now",
      "`worker`, but an explicit setting wins and yours has not been changed.",
      "",
      "To take the new default, remove that line (or set it to `worker`).",
    );
  } else if (alsoFull.length > 0) {
    lines.push(
      `These instances are set to \`tool_set: full\` and keep every tool: ${alsoFull.join(", ")}.`,
      "AgEnD's default is now `worker`; an explicit setting wins and yours have not been changed.",
    );
  }

  if (candidates.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${candidates.length} instance${candidates.length === 1 ? " has" : "s have"} used tools a worker does not get.`,
      "Mark them `tool_set: coordinator` so they keep working:",
      "",
    );
    for (const c of candidates) {
      const used = c.refusedTools.map(([tool, count]) => `${tool}×${count}`).join(" ");
      lines.push(`  ${c.instance}   ${used}`);
    }
    lines.push(
      "",
      // The derivation only sees one of the three paths a tool call can take,
      // so this says what it found rather than claiming it found everything.
      "That list is what recent activity shows; an agent that has been quiet may still need marking.",
    );
  }

  if (lines.length === 0) return null;
  return ["AgEnD tool permissions have changed.", "", ...lines].join("\n");
}
