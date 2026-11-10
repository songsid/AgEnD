// S-120 r3 proposal data (after #3553): GET answers only (nothing is written). Shapes as the server sends them.
// CHAT=1: a fleet with a chat connection (another admin's device cannot be signed out here: other_admin).
export default async function (ctx: any, page: any, c: any) {
  const now = Date.now(), m = 60_000, chat = process.env.CHAT === "1";
  const D = (handle: string, label: string, tier: string, verified: boolean, ago: number, extra: any = {}) =>
    ({ handle, label, tier, verified, via: "code", lastSeen: now - ago, current: false, canSignOut: true, ...extra });
  const devices = chat ? [
    D("a1a1a1a1a1a1a1a1", "Chrome on Linux", "admin", true, 0, { current: true }),
    D("b2b2b2b2b2b2b2b2", "Safari on iPhone", "admin", true, 12 * m),
    D("c3c3c3c3c3c3c3c3", "Edge on Windows", "admin", false, 3 * 3600_000, { canSignOut: false, signOutBlocked: "other_admin" }),
    D("d4d4d4d4d4d4d4d4", "Chrome on Android", "guest", false, 25 * m),
    D("e5e5e5e5e5e5e5e5", "Firefox on Mac", "read", false, 2 * 3600_000),
  ] : [
    D("a1a1a1a1a1a1a1a1", "Chrome on Linux", "admin", true, 0, { current: true }),
    D("b2b2b2b2b2b2b2b2", "Safari on iPhone", "admin", false, 12 * m),
    D("d4d4d4d4d4d4d4d4", "Chrome on Android", "guest", false, 25 * m),
  ];
  const outside = { webOnly: !chat, here: true, manage: true, codeNeeded: false, strict: true, enrolled: true,
    enrolledAt: now - 86400_000, outside: !chat, pausedForMs: 0, link: { state: "open", expiresAt: now + 100 * m, quick: true } };
  const get = (pat: string, body: any) => ctx.route(pat, (r: any) => r.request().method() === "GET" ? r.fulfill({ json: body }) : r.continue());
  await get("**/ui/devices", { webOnly: !chat, owner: true, devices });
  await get("**/ui/outside", outside);
  await get("**/ui/office-share", { enabled: true, shares: [{ id: "s1" }] });
  await get("**/ui/page-share", { enabled: true, cdn: false, shares: [{ id: "p1" }] });
  await get("**/ui/runtimes", { enabled: true, machines: [{ id: "m1" }, { id: "m2" }], enrollments: [] });
}
