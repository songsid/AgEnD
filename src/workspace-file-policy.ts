/**
 * Files/Changes and Follow share this conservative filename policy (#3153/#3160).
 * Match case-insensitively on EVERY relative path component, including directories:
 * - known private names, also with a dot/dash/underscore backup suffix;
 * - prefixes .env*, id_*, kubeconfig* and .kubeconfig*;
 * - private/key/store extensions, also with a separated backup suffix;
 * - credential, secret, password or private[-_]?key anywhere in a name.
 * False positives are deliberate. This is not a content scanner or a path-confinement check.
 */
const PRIVATE_NAMES = [".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config", ".agend", ".claude", ".codex", ".kiro",
  ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".pgpass", "credentials", "credentials.json", "auth.json", "secrets.json",
  "known_hosts", "authorized_keys", ".htpasswd", ".vault-token", ".s3cfg", ".boto", "terraform.tfstate", "terraform.tfstate.backup"];
const PRIVATE_PREFIXES = [".env", "id_", "kubeconfig", ".kubeconfig"];
const PRIVATE_EXTENSION = /\.(?:pem|key|p12|p8|pfx|jks|keystore|kdbx|asc|gpg|ppk|token|env|tfvars|tfstate)(?:$|[._-])/;
const PRIVATE_CONTAINS = /credential|secret|password|private[-_]?key/;

function privateName(name: string): boolean {
  if (PRIVATE_NAMES.some(fixed => name === fixed || name.startsWith(fixed) && /^[._-]/.test(name.slice(fixed.length)))) return true;
  if (PRIVATE_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
  if (PRIVATE_EXTENSION.test(name) || PRIVATE_CONTAINS.test(name)) return true;
  return /^service[-_]?account.*\.json(?:$|[._-])/.test(name) || /^\.[a-z0-9]*_?history(?:$|[._-])/.test(name);
}

/** Workspace-relative, slash-separated spelling; an ambiguous spelling is hidden as well as refused by confinement. */
export function isHiddenPath(rel: string): boolean {
  if (/[\u0000-\u001f\u007f\\]/.test(rel)) return true;
  return rel.split("/").filter(Boolean).some(part => privateName(part.toLowerCase()));
}
