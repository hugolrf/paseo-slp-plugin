/** What the BOUND runtime declares it can read (its `FORMATION_CAPABILITIES`), measured from the verified candidate.
 * The Clientes screen writes version-2 features only a candidate that declares them can read back (`clientContainers`).
 * Read-only: verify the published candidate, import its launch module, copy the constant. Unknown (no active binding,
 * failed verification, unreadable module) is `null`, never "supported". */
import { pathToFileURL } from "node:url";
import { candidateModulePath } from "./candidate-module.ts";

export interface RuntimeBindingLike { runtimePath: string; candidateSha256: string; payloadSha256: string }
export function createRuntimeCapabilities(deps: {
  readActiveBinding: () => RuntimeBindingLike | null;
  verify: (binding: RuntimeBindingLike) => Promise<void> | void;
  importModule?: (specifier: string) => Promise<{ FORMATION_CAPABILITIES?: unknown }>;
}): () => Promise<Record<string, number> | null> {
  const cache = new Map<string, Record<string, number>>();
  return async () => {
    let binding: RuntimeBindingLike | null;
    try { binding = deps.readActiveBinding(); } catch { return null; }
    if (binding === null) return null;
    const cached = cache.get(binding.candidateSha256);
    if (cached !== undefined) return cached;
    try {
      await deps.verify(binding);
      const mod = await (deps.importModule ?? (specifier => import(specifier)))(pathToFileURL(candidateModulePath(binding.runtimePath, "launch")).href);
      const declared = mod.FORMATION_CAPABILITIES;
      const capabilities: Record<string, number> = {};
      if (declared !== null && typeof declared === "object") for (const [key, value] of Object.entries(declared)) if (typeof value === "number") capabilities[key] = value;
      cache.set(binding.candidateSha256, capabilities);
      return capabilities;
    } catch { return null; }
  };
}
