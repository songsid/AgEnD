import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicCommands } from "../src/topic-commands.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import type { FleetConfig } from "../src/types.js";

const tokenName="AGEND_TEST_NATIVE_TOPIC_TOKEN",nativeId="12345678-1234-4321-abcd-123456789012";
function fixture(type:"telegram"|"discord"="telegram"){
  const channel={type,bot_token_env:tokenName,group_id:type==="telegram"?-100123456:"999888777666555444",...(type==="discord"?{general_channel_id:"111222333444555666"}:{})};
  const fleet:FleetConfig={channel:channel as any,defaults:{},instances:{
    native:{...structuredClone(DEFAULT_INSTANCE_CONFIG),runtime:"windows",native_agent_id:nativeId,native_sandbox:"read-only",working_directory:"J:\\Work\\Native",backend:"codex"},
    linux:{...structuredClone(DEFAULT_INSTANCE_CONFIG),working_directory:"/tmp/linux-project",backend:"codex"},
  }};
  const createForumTopic=vi.fn(async()=>12345),saveFleetConfig=vi.fn(),logger={info:vi.fn(),warn:vi.fn()};
  const context={fleetConfig:fleet,createForumTopic,saveFleetConfig,logger} as unknown as ConstructorParameters<typeof TopicCommands>[0];
  return{fleet,createForumTopic,saveFleetConfig,logger,commands:new TopicCommands(context)};
}
beforeEach(()=>vi.stubEnv(tokenName,"fixture-only-token"));
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe("native runtimes do not acquire external channel topics automatically",()=>{
  it("creates a topic for the Linux member of a mixed fleet and leaves native config unchanged",async()=>{
    const f=fixture(),nativeBefore=structuredClone(f.fleet.instances.native),network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("Unexpected external request"));
    await f.commands.autoCreateTopics();
    expect(f.createForumTopic).toHaveBeenCalledOnce();expect(f.createForumTopic).toHaveBeenCalledWith("linux-project");
    expect(f.fleet.instances.linux.topic_id).toBe(12345);expect(f.fleet.instances.native).toEqual(nativeBefore);
    expect(f.fleet.instances.native).not.toHaveProperty("topic_id");expect(f.saveFleetConfig).toHaveBeenCalledOnce();expect(network).not.toHaveBeenCalled();
  });
  it("does not bind a Windows General while preserving the existing Linux General binding behavior",async()=>{
    const f=fixture("discord");f.fleet.instances.native.general_topic=true;f.fleet.instances.linux.general_topic=true;
    await f.commands.autoCreateTopics();
    expect(f.fleet.instances.native).not.toHaveProperty("topic_id");expect(f.fleet.instances.linux.topic_id).toBe("111222333444555666");
    expect(f.createForumTopic).not.toHaveBeenCalled();expect(f.saveFleetConfig).toHaveBeenCalledOnce();
  });
  it("does not create topics or save config for a fleet containing only native runtimes",async()=>{
    const f=fixture();delete f.fleet.instances.linux;const before=structuredClone(f.fleet);
    await f.commands.autoCreateTopics();
    expect(f.createForumTopic).not.toHaveBeenCalled();expect(f.saveFleetConfig).not.toHaveBeenCalled();expect(f.fleet).toEqual(before);
  });
});
