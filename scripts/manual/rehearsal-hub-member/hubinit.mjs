// hubinit.mjs: a dedicated Hub account initialized as `agend hub init` does it (the real initializer from the INSTALLED
// package, the AD profile against the rig's fake AD on :636), non-interactively. Run as the hub user. The fleet service
// (`agend install`) then mounts it; this script never starts a runtime.
import { readFileSync, existsSync } from "node:fs";
const app = process.argv[2], home = process.argv[3];
const { createHubInitializer } = await import(`${app}/dist/hub/init/initializer.js`);
const { hubIdentityProvider } = await import(`${app}/dist/hub/init/identity.js`);
const users = JSON.parse(readFileSync("/opt/acc/users.json", "utf8")), ca = readFileSync("/opt/acc/ad-ca.pem", "utf8");
console.log("hub package", JSON.parse(readFileSync(`${app}/package.json`, "utf8")).version);
if (existsSync(`${home}/hub/init-manifest.json`)) { console.log("already initialized"); process.exit(0); }
const directory = { realm: "example", url: "ldaps://ad.example.test", profile: "ad", caPem: ca, baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test" };
const plan = {
  name: "Rig Hub", webOrigin: "https://hub.example.test:18601", memberOrigin: "https://hub.example.test:18602",
  memberListen: { host: "127.0.0.1", port: 18602 }, webListen: { host: "127.0.0.1", port: 18601 },
  webTls: { certFile: `${process.env.HOME}/hubtls/server.pem`, keyFile: `${process.env.HOME}/hubtls/server.key` },
  directory, bindPasswordRef: "file:hub/secrets/directory-bind",
  administrator: { realm: "example", objectId: users.find((u) => u.login === "alice").id },
  retention: { contentDays: 30, eventDays: 180 }, coexistence: "dedicated",
};
const init = createHubInitializer({ home, identity: hubIdentityProvider() });
const confirmation = await init.prepareConfirmation(plan, { bindPassword: "Dummy-service-only" });
if (confirmation.problems?.length) { console.log("problems", JSON.stringify(confirmation.problems)); process.exit(1); }
const done = await init.commit(plan, confirmation.reference);
console.log("hub initialized", done?.hubId ?? "");
