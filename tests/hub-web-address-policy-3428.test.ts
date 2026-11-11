/** New address admission is narrow: bare HTTPS, explicit listener, no listener/origin collisions. */
import { describe, expect, it } from "vitest";
import { parseHubWebAddressCandidate } from "../src/hub/settings-web-address-policy.js";
const hub = { webOrigin: "https://hub.example.test:18444", memberOrigin: "https://members.example.test:18443",
    webListen: { host: "127.0.0.1", port: 18444 }, memberListen: { host: "127.0.0.1", port: 18443 }, web: { preview_port: 18445 } };
const input = { origin: "https://new.example.test:19444", listen: { host: "127.0.0.1", port: 19444 }, certificate: { mode: "generate" } };
describe("#3428 web address candidate", () => {
    it("admits an exact new HTTPS address and leaves member/preview configuration untouched", () => {
        const before = structuredClone(hub);
        expect(parseHubWebAddressCandidate(input, hub)).toEqual(input);
        expect(hub).toEqual(before);
    });
    it.each(["http://new.example.test", "https://user:password@new.example.test", "https://new.example.test/path", "https://new.example.test?x=1", "https://new.example.test#token", "https://new.example.test."])("refuses non-bare or ambiguous origin %s", origin => {
        expect(() => parseHubWebAddressCandidate({ ...input, origin }, hub)).toThrow();
    });
    it.each(["0.0.0.0", "::", "*", "", "host/name"])("never broadens the bind to %s", host => {
        expect(() => parseHubWebAddressCandidate({ ...input, listen: { host, port: 19444 } }, hub)).toThrow();
    });
    it.each([0, -1, 65536, 1.5, "19444"])("refuses invalid port %s", port => {
        expect(() => parseHubWebAddressCandidate({ ...input, listen: { host: "127.0.0.1", port } }, hub)).toThrow();
    });
    it.each([18443, 18445])("refuses member/preview port collision %s even through an alias", port => {
        expect(() => parseHubWebAddressCandidate({ ...input, listen: { host: "localhost", port } }, hub)).toThrow();
    });
    it("refuses equal member origin, extra keys and mixed certificate modes", () => {
        expect(() => parseHubWebAddressCandidate({ ...input, origin: hub.memberOrigin }, hub)).toThrow();
        expect(() => parseHubWebAddressCandidate({ ...input, administrator: "attacker" }, hub)).toThrow();
        expect(() => parseHubWebAddressCandidate({ ...input, certificate: { mode: "generate", keyPem: "secret" } }, hub)).toThrow();
    });
    it("keeps an existing explicit bind when only the public origin changes", () => {
        expect(parseHubWebAddressCandidate({ ...input, listen: hub.webListen, certificate: { mode: "keep" } }, hub).listen).toEqual(hub.webListen);
    });
});
