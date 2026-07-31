import { createHash } from "crypto";
import type { FrozenCampaignManifest } from "../types";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Frozen campaign manifest must contain JSON values only");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function frozenCampaignObjectHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function frozenCampaignManifestHash(manifest: FrozenCampaignManifest): string {
  return frozenCampaignObjectHash(manifest);
}

export function parseFrozenCampaignManifest(value: unknown): FrozenCampaignManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || !manifest.smoke_task || typeof manifest.smoke_task !== "object"
    || Array.isArray(manifest.smoke_task) || !manifest.dag || typeof manifest.dag !== "object"
    || Array.isArray(manifest.dag)) return undefined;
  const smoke = manifest.smoke_task as Record<string, unknown>;
  const dag = manifest.dag as Record<string, unknown>;
  if (typeof smoke.script !== "string" || !smoke.script.trim() || !Array.isArray(dag.task_specs) || dag.task_specs.length === 0
    || dag.task_specs.some((spec) => !spec || typeof spec !== "object" || Array.isArray(spec)
      || typeof (spec as Record<string, unknown>).ref !== "string"
      || typeof (spec as Record<string, unknown>).script !== "string")) return undefined;
  return manifest as unknown as FrozenCampaignManifest;
}

export function requireFrozenCampaignManifest(
  manifest: FrozenCampaignManifest | undefined,
  expectedHash: string,
): FrozenCampaignManifest {
  if (!manifest) throw new Error("Campaign has no frozen manifest");
  if (frozenCampaignManifestHash(manifest) !== expectedHash) {
    throw new Error("Campaign frozen manifest hash mismatch");
  }
  return manifest;
}
