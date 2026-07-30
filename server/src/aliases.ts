import { createHash } from "crypto";

export type AliasObjectKind = "task" | "experiment" | "campaign" | "capacity_lease" | "slurm_allocation";

const PREFIXES: Record<AliasObjectKind, string> = {
  task: "task",
  experiment: "exp",
  campaign: "camp",
  capacity_lease: "lease",
  slurm_allocation: "alloc",
};

// Scheme v1 is append-only. Reordering/removing words would change aliases for
// objects that have not yet been persisted by a backfill.
const ADJECTIVES = [
  "amber", "bold", "bright", "calm", "clear", "cobalt", "cool", "coral",
  "crisp", "eager", "fair", "gentle", "golden", "green", "happy", "honest",
  "ivory", "jolly", "keen", "kind", "lively", "lucid", "mellow", "navy",
  "noble", "quiet", "rapid", "silver", "silent", "steady", "swift", "warm",
] as const;

const NOUNS = [
  "badger", "cedar", "comet", "crane", "dolphin", "eagle", "falcon", "fern",
  "fox", "gecko", "heron", "iris", "jade", "koala", "lark", "lynx",
  "maple", "otter", "panda", "pearl", "pine", "raven", "river", "robin",
  "sparrow", "stone", "tiger", "valley", "willow", "wolf", "wren", "yak",
] as const;

const BASE32 = "23456789abcdefghjkmnpqrstuvwxyz";
export const ALIAS_SCHEME_VERSION = 1;

export function generateMnemonicAlias(kind: AliasObjectKind, objectId: string, nonce = 0): string {
  const digest = createHash("sha256")
    .update(`alchemy-alias-v${ALIAS_SCHEME_VERSION}:${kind}:${objectId}:${nonce}`)
    .digest();
  const adjective = ADJECTIVES[digest[0] % ADJECTIVES.length];
  const noun = NOUNS[digest[1] % NOUNS.length];
  let suffix = "";
  for (let i = 2; i < 8; i += 1) suffix += BASE32[digest[i] % BASE32.length];
  return `${PREFIXES[kind]}-${adjective}-${noun}-${suffix}`;
}
