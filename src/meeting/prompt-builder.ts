import type { MeetingRole, RoundEntry } from "./types.js";

const ROLE_LABELS: Record<string, string> = { pro: "正方", con: "反方", arbiter: "仲裁" };

export function roleLabel(role: MeetingRole): string {
  return ROLE_LABELS[role] ?? role;
}

export function buildSystemPrompt(role: MeetingRole, topic: string): string {
  const label = roleLabel(role);
  switch (role) {
    case "pro":
      return `你是這場辯論的「${label}」。議題：「${topic}」。\n\n你必須站在【贊成/支持】的立場。無論你個人怎麼想，你的任務就是為這個提案辯護，找出所有支持它的理由。\n\n重要：你必須跟反方持相反立場。如果反方同意你，那代表你們其中一方搞錯立場了。你要積極反駁反方的論點。\n\n用 reply 工具回覆你的論述。`;
    case "con":
      return `你是這場辯論的「${label}」。議題：「${topic}」。\n\n你必須站在【反對/質疑】的立場。無論你個人怎麼想，你的任務就是反對這個提案，找出所有反對它的理由、風險和問題。\n\n重要：你必須跟正方持相反立場。如果正方支持這個提案，你就必須反對。不要附和正方，要挑戰和反駁他的論點。\n\n用 reply 工具回覆你的論述。`;
    case "arbiter":
      return `你是這場辯論的「${label}」。議題：「${topic}」。你的角色是客觀的仲裁者，分析正反雙方論點的優劣，指出各方的盲點和邏輯漏洞，並提出平衡的結論。\n\n用 reply 工具回覆你的分析。`;
    default:
      return `你是這場辯論的「${label}」。議題：「${topic}」。用 reply 工具回覆你的觀點。`;
  }
}

export function buildRoundPrompt(topic: string, round: number, previousRounds: RoundEntry[], userContext?: string): string {
  const parts: string[] = [`--- Round ${round} ---`, `議題：${topic}`];
  if (previousRounds.length > 0) {
    parts.push("\n上一輪討論摘要：");
    for (const entry of previousRounds) {
      parts.push(`[${roleLabel(entry.role)} ${entry.speaker}] ${entry.content}`);
    }
    parts.push("\n請針對以上觀點進行回應。");
  } else {
    parts.push("\n這是第一輪。請闡述你的立場。");
  }
  if (userContext) {
    parts.push(`\n主持人補充：${userContext}`);
  }
  return parts.join("\n");
}

export function buildCollabSystemPrompt(label: string, topic: string): string {
  return `你是協作任務的參與者「${label}」。任務：「${topic}」。你在獨立的 git branch 上工作。先討論分工，確認後開始開發。完成後用 reply 工具回報進度。`;
}

export function buildCollabSummaryPrompt(topic: string, allRounds: RoundEntry[]): string {
  const parts: string[] = [`請為以下協作任務產出一份工作摘要。`, `任務：${topic}`, ""];
  for (const entry of allRounds) {
    parts.push(`[${entry.speaker}] ${entry.content}`);
  }
  parts.push("\n請總結：1) 各參與者完成了什麼 2) 未完成的工作 3) 需要注意的衝突或問題。用 reply 工具回覆摘要。");
  return parts.join("\n");
}

export function buildSummaryPrompt(topic: string, allRounds: RoundEntry[]): string {
  const parts: string[] = [`請為以下辯論產出一份會議摘要。`, `議題：${topic}`, ""];
  let currentRound = 0;
  for (const entry of allRounds) {
    if (entry.round !== currentRound) {
      currentRound = entry.round;
      parts.push(`\n--- Round ${currentRound} ---`);
    }
    parts.push(`[${roleLabel(entry.role)} ${entry.speaker}] ${entry.content}`);
  }
  parts.push("\n請總結：1) 各方主要論點 2) 共識點 3) 未解決的分歧 4) 建議的下一步行動。用 reply 工具回覆摘要。");
  return parts.join("\n");
}
