/** Client rules and strict binding at agent creation (agent.create hook).
 *
 * The central client map (version 2) binds a Git checkout to a client and can
 * carry that client's rules. The block is rendered when the agent is created,
 * from the map, never stored in a workspace protocol. Under a valid STRICT map
 * a checkout with no client fails closed with a message that points at the
 * Clients screen; creating the project/workspace itself is never blocked (this
 * hook only runs for slp-* providers). An absent, invalid or version 1 map, and
 * any non-strict problem, keep today's behavior: no block, no rules. */
import { isAbsolute } from "node:path";
import { ClientMapError, clientMapPosture, ladderBinding } from "./runtime/cli/clients.ts";

const blockMessage = (error: ClientMapError): string => {
  const hint = error.code === "CLIENT_UNMAPPED"
    ? "o mapa de clientes está no modo estrito e este projeto não tem cliente; mapeie o projeto na tela Clientes"
    : error.code === "CLIENT_IDENTITY_DRIFT"
      ? "a identidade Git do repositório diverge do mapa de clientes; revise o projeto na tela Clientes"
      : "o mapa de clientes bloqueia este projeto; revise a tela Clientes";
  return `Clientes: ${hint} (${error.code}: ${error.message}).`;
};

/** The pt-BR rules block for `cwd`, or null when none applies. Throws to abort the create.
 * Under a valid STRICT map a missing, empty or relative cwd cannot be bound to a client and fails
 * closed with the same message; with no map, a version 1 map or a non-strict map nothing changes.
 * A non-strict map with no rule anywhere returns before running Git. */
export function clientContextForCwd(cwd: string | undefined, home: string): string | null {
  const posture = clientMapPosture(home);
  if (posture === null) return null;
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
    if (!posture.strict) return null;
    throw new Error(blockMessage(new ClientMapError("CLIENT_UNMAPPED", "strict client map: the agent has no absolute working directory, so it cannot be bound to a client; no user-pool fallback")));
  }
  if (!posture.strict && !posture.hasRules) return null;
  try { return ladderBinding({ home, cwd })?.rulesText ?? null; }
  catch (error) { throw error instanceof ClientMapError ? new Error(blockMessage(error)) : error; }
}
