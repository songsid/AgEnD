/** AgEnD Hub directory sign-in (S-43). Import this module only when the Hub is enabled; it loads the LDAP client lazily. */
export type { DirectoryPerson, DirectoryLookupResult, Eligibility, HubDirectory, IneligibleReason, InitializationLookupResult, PersonKey, SignInRefusal, SignInResult } from "./types.js";
export { personKeyString, samePerson } from "./types.js";
export type { DirectoryProfile, HubDirectoryConfig } from "./config.js";
export { HubDirectoryConfigError, resolveDirectoryConfig } from "./config.js";
export type { HubDirectoryDiagnostic, HubDirectoryOptions, HubDirectorySecrets } from "./directory.js";
export { createHubDirectory } from "./directory.js";
export type { DirectoryPolicyGroup, PolicyGroupFacts, PolicyGroupLookup } from "./groups.js";
