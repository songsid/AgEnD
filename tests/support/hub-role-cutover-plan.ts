/** Existing pre-role schema used by the owned migration/crash fixtures, never runtime composition. */
import {HUB_INSTANCE_MIGRATION} from "../../src/hub/db.js";
import {HUB_AUDIT_MIGRATION} from "../../src/hub/audit/index.js";
import {HUB_TRANSPORT_MIGRATION} from "../../src/hub/store.js";
import {HUB_HTTP_MIGRATIONS} from "../../src/hub/http/schema.js";
import {groupPolicyMigration} from "../../src/hub/group-policy/store.js";
import {HUB_GROUP_RESOURCES_MIGRATION} from "../../src/hub/group-policy/resources.js";
import {HUB_COMPANY_JOIN_MIGRATION} from "../../src/hub/join/store.js";
import {HUB_ENROLMENT_CODE_MIGRATION} from "../../src/hub/enrolment-code.js";
import {HUB_PAIRING_NOTICES_MIGRATION} from "../../src/hub/pairing-notices.js";
export const roleCutoverLegacyPlan=(hubId:string)=>[HUB_INSTANCE_MIGRATION,HUB_AUDIT_MIGRATION,HUB_TRANSPORT_MIGRATION,...HUB_HTTP_MIGRATIONS,groupPolicyMigration(hubId,"corp","g1"),HUB_GROUP_RESOURCES_MIGRATION,HUB_COMPANY_JOIN_MIGRATION,HUB_ENROLMENT_CODE_MIGRATION,HUB_PAIRING_NOTICES_MIGRATION];
