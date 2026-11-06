// The desk store, bridge and operator recovery read the same lock record.
// This module interprets the bytes and syscall result; each caller still
// owns waiting, re-entry, release and the authority to recover a lock.
import { fstatSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { DESK_RECOVERY_LIMITS } from "../../shared/runtime/desk-contract.ts";

export interface LockHolder {
  pid: number;
  instanceNonce: string;
  startedAt?: string;
  processIdentity?: string;
}

export function parseLockHolder(bytes: Buffer | string): LockHolder | null {
  try {
    const value: unknown = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const { pid, instanceNonce, startedAt, processIdentity } = value as Record<string, unknown>;
    if (
      typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
      typeof instanceNonce !== "string" || instanceNonce.length === 0 ||
      instanceNonce.length > DESK_RECOVERY_LIMITS.recoverNonce
    ) return null;
    if (processIdentity !== undefined &&
        (typeof processIdentity !== "string" || processIdentity.length === 0 || processIdentity.length > 128)) return null;
    return { pid, instanceNonce, ...(typeof startedAt === "string" ? { startedAt } : {}),
      ...(typeof processIdentity === "string" ? { processIdentity } : {}) };
  } catch {
    return null;
  }
}

/** How a lock holder relates to the instance reading the lock. `pid` alone
 *  cannot tell a holder in ANOTHER process from a previous or parallel
 *  instance in THIS process: both answer kill(pid, 0) alive, but only the
 *  latter can be a leftover of a plugin instance the host already replaced.
 *  The nonce is per-instance, so same pid + different nonce is the second
 *  case. Neither case authorises removal — this only names the situation. */
export type LockHolderRelation = "self" | "same-process-other-instance" | "other-process";

export function relateLockHolder(
  holder: Pick<LockHolder, "pid" | "instanceNonce">,
  self: { pid: number; instanceNonce: string },
): LockHolderRelation {
  if (holder.pid !== self.pid) return "other-process";
  return holder.instanceNonce === self.instanceNonce ? "self" : "same-process-other-instance";
}

/** Age since the holder's recorded `startedAt`, or an explicit "unknown" —
 *  never a guess (a missing, unparseable or future timestamp is doubt). */
export function formatLockAge(startedAt: string | undefined, nowMs: number): string {
  const startedMs = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "unknown (no usable startedAt)";
  const seconds = Math.floor((nowMs - startedMs) / 1000);
  if (seconds < 0) return "unknown (startedAt is in the future)";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** One-line holder facts shared by every lock diagnostic: who, since when,
 *  and exactly which file and namespace. */
export function describeLockHolder(input: {
  repoKey: string;
  lockPath: string;
  holder: Pick<LockHolder, "pid" | "instanceNonce" | "startedAt">;
  nowMs: number;
}): string {
  const { holder } = input;
  return (
    `pid ${holder.pid}, nonce ${holder.instanceNonce}, age ${formatLockAge(holder.startedAt, input.nowMs)}` +
    `${holder.startedAt !== undefined ? ` (startedAt ${holder.startedAt})` : ""}; ` +
    `repoKey ${input.repoKey}; lock ${input.lockPath}`
  );
}

/** Identity of the lock file a call just created with O_EXCL (`wx`). */
export interface CreatedLockFile { dev: number; ino: number }

export function createdLockFile(fd: number): CreatedLockFile | null {
  try {
    const stat = fstatSync(fd);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

export type CreatedLockCleanup = "removed" | "absent" | "left";

/** Self-cleanup of a lock file THIS call created when writing its holder
 *  record failed. Fail-closed: the path is unlinked only while it is still
 *  the very file this call created (same dev + ino, regular file). The caller
 *  MUST run this while the creating fd is still open — an open fd keeps the
 *  inode allocated, so the dev+ino comparison cannot be fooled by inode
 *  reuse. Anything unverifiable (identity unknown, replaced, not a regular
 *  file, unlink failed) is `left` and must be diagnosed by the caller; a path
 *  that is simply gone is `absent`. A lstat→unlink race with a foreign
 *  replacement is not closed (no unlink-by-inode exists). */
export function removeCreatedLockFile(path: string, created: CreatedLockFile | null): CreatedLockCleanup {
  if (created === null) return "left";
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.dev !== created.dev || stat.ino !== created.ino) return "left";
    unlinkSync(path);
    return "removed";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "absent" : "left";
  }
}

/** Diagnostic suffix when the failed acquire could not remove its own file. */
export function leftLockNote(cleanup: CreatedLockCleanup, lockPath: string): string {
  return cleanup === "left" ? `; lock file left in place at ${lockPath} (could not confirm it is the file this call created)` : "";
}

/** Same facts for a lock whose holder record cannot be read or parsed. */
export function describeLockPath(input: { repoKey: string; lockPath: string }): string {
  return `repoKey ${input.repoKey}; lock ${input.lockPath}`;
}

export type LockHolderProcess = "alive" | "esrch" | "eperm" | "undetermined";

export function classifyLockHolderProcess(pid: number, kill: (pid: number) => void): LockHolderProcess {
  try {
    kill(pid);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ESRCH") return "esrch";
    if (code === "EPERM") return "eperm";
    return "undetermined";
  }
}

/** Linux/WSL kernel identity: boot UUID + process start ticks, independent of
 * wall-clock time and PID reuse. Missing host capability is identity doubt;
 * other platforms retain ESRCH-only recovery. */
export function readProcessIdentity(pid: number, deps: {
  platform?: string;
  readFile?: (path: string) => string;
} = {}): string | null {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const bootPath = "/proc/sys/kernel/random/boot_id";
    const boot = readFile(bootPath).trim();
    const stat = readFile(`/proc/${pid}/stat`);
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(boot) || !/^\d+$/.test(ticks ?? "") ||
        readFile(bootPath).trim() !== boot) return null;
    return `${boot}:${ticks}`;
  } catch { return null; }
}
