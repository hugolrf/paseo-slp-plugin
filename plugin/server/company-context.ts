/** Bind managed Equipes sessions to a verified company Git identity. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
type Project = { company: string; project: string; gitCommonDir: string; originSha256: string };
type Policy = { instructions: string; sourceNotes: string[] };
type Manifest = { version: 1; protectedRoots: string[]; companies: Record<string, Policy>; projects: Project[] };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: string) => {
  if (!isAbsolute(value)) throw new Error("Equipes: company binding requires an absolute path");
  return realpathSync(value);
};
const belongs = (root: string, cwd: string) => {
  const rest = relative(root, cwd);
  return rest === "" || (rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest));
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2500,
    maxBuffer: 4096, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() },
  }).trim();
export function companyContextForCwd(cwd: string | undefined,
  path = join(homedir(), ".config", "equipes", "companies.json")): string | null {
  if (cwd === undefined) return null;
  const location = canonical(cwd);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      let common = "";
      try { common = canonical(resolve(location, git(location, "rev-parse", "--git-common-dir"))); } catch { /* non-git is not a managed company repo */ }
      if ([location, common].some(value => value.includes("/Projetos/PDCase/") || value.includes("/Projetos/Fourtime/"))) {
        throw new Error("Equipes: corporate policy registry unavailable");
      }
      return null;
    }
    throw error;
  }
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Equipes: company registry must be a bounded regular file");
  let registry: Manifest;
  try { registry = JSON.parse(readFileSync(path, "utf8")) as Manifest; }
  catch { throw new Error("Equipes: company registry is unreadable"); }
  if (registry.version !== 1 || !Array.isArray(registry.protectedRoots) ||
    !Array.isArray(registry.projects) || !registry.companies ||
    typeof registry.companies !== "object") throw new Error("Equipes: invalid company registry");
  const roots = registry.protectedRoots.map(canonical);
  let commonDir: string, remoteSha: string;
  try {
    commonDir = canonical(resolve(location, git(location, "rev-parse", "--git-common-dir")));
    remoteSha = sha(git(location, "remote", "get-url", "origin"));
  } catch {
    if (roots.some(root => belongs(root, location))) {
      // A client container folder (not a repository) that holds registered
      // projects of exactly one company is legitimate for a Supervisor/Geral
      // workspace: bind that company, never guess across companies.
      const prefix = location.endsWith("/") ? location : location + "/";
      const under = registry.projects.filter(item => item.gitCommonDir.startsWith(prefix));
      const owners = new Set(under.map(item => item.company));
      if (owners.size !== 1) throw new Error("Equipes: corporate Git identity is unverified");
      return render(under[0].company, "(pasta do cliente)", registry.companies[under[0].company]);
    }
    return null;
  }
  // Paseo PR workspaces live under ~/.paseo/worktrees. Bind the company by
  // the canonical Git common-dir, not by the transient worktree location.
  const corporate = roots.some(root => belongs(root, location) || belongs(root, commonDir));
  if (!corporate) return null;
  const matches = registry.projects.filter(project => project.gitCommonDir === commonDir);
  if (matches.length !== 1) throw new Error("Equipes: corporate repository is not uniquely registered");
  const project = matches[0];
  if (project.originSha256 !== remoteSha) throw new Error("Equipes: corporate remote identity drift");
  return render(project.company, project.project, registry.companies[project.company]);
}
function render(company: string, projectName: string, policy: Policy | undefined): string {
  if (!policy || typeof policy.instructions !== "string" ||
    !policy.instructions.trim() || policy.instructions.length > 2200 ||
    !Array.isArray(policy.sourceNotes) ||
    policy.sourceNotes.some(note => typeof note !== "string" || note.length > 240)) {
    throw new Error("Equipes: company policy is missing or invalid");
  }
  return [
    "\n## Contexto empresarial obrigatório: " + company + " / " + projectName,
    "Vínculo verificado pelo Git common-dir e hash da origem; nunca herdar políticas, cota, fallback ou credenciais de outra empresa.",
    "As notas são fontes de contexto a verificar; não substituem reserva exclusiva da tarefa nem autorizações de ações externas.",
    policy.instructions.trim(),
    "Antes de modificar código corporativo, conferir origem da tarefa e reserva válida do controlador; sem evidência, BLOCKED.",
    "QA exige E2E efetivamente executado, candidato pinado e evidências com hashes no destino externo autorizado. Sem prova, NOT_HOMOLOGATED.",
    "Notas do Cérebro desta empresa (não abrir notas de outras empresas): " + policy.sourceNotes.join("; "),
    "Esta orientação não autoriza escrita na origem/Multica, deploy, tag, merge, produção, gastos ou ações irreversíveis.\n",
  ].join("\n");
}
