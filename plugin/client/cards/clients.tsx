// "Clientes" card: the central client map edited in the Manager instead of by
// hand. The card owns the map draft (one per target/host), the selected client,
// the protocol draft, the two-step review → confirm save and the diagnosis
// readout. Validation, identity (common-dir/origin hash), diagnosis and every
// write run on the server through plugin/server/clients-store.ts; this file
// only shows server results and echoes the server's `confirm` token back. The
// pool editor is the existing Peer pool card, mounted for the selected client
// through adapters (ManagerSurface). Clients never mix: every draft is keyed by
// target and client.
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "../pt-br.ts";
import type {
  ClientProjectRowValue,
  ClientRulesDraftValue,
  ClientsMapDraftValue,
  ExplainResolutionResult,
  GetClientFilesResult,
  GetClientsResult,
  GetPeerPoolRequest,
  GetPeerPoolResult,
  IdentifyRepositoryResult,
  ListClientProjectsResult,
  PeerPoolValue,
  SetPeerPoolRequest,
  SetPeerPoolResult,
  TargetValue,
  ValidateClientsDraftResult,
} from "../../shared/contracts.ts";
import { errorMessage } from "../manager-state.ts";
import { useTargetSnapshot } from "../target-async.ts";
import { Badge, Button, Card, ChipSelect, Field, KV, SwitchRow, styles } from "../ui-kit.tsx";
import type { Colors } from "../ui-kit.tsx";

export type ClientsApi = {
  getClients(input: { schemaVersion: 1; target: TargetValue }): Promise<GetClientsResult>;
  getClientFiles(input: { schemaVersion: 1; target: TargetValue; client: string }): Promise<GetClientFilesResult>;
  validate(input: { schemaVersion: 1; target: TargetValue; draft:
    | { kind: "map"; map: ClientsMapDraftValue }
    | { kind: "pool"; client: string; pool: PeerPoolValue }
    | { kind: "protocol"; client: string; text: string } }): Promise<ValidateClientsDraftResult>;
  identify(input: { schemaVersion: 1; target: TargetValue; path: string }): Promise<IdentifyRepositoryResult>;
  /** Every project the host lists, classified by the server (bound / pending / blocked / not-git). */
  listProjects(input: { schemaVersion: 1; target: TargetValue; workspaces: { id: string; name: string; path: string }[] }): Promise<ListClientProjectsResult>;
  explain(input: { schemaVersion: 1; target: TargetValue; path: string }): Promise<ExplainResolutionResult>;
  setClients(input: { schemaVersion: 1; target: TargetValue; map: ClientsMapDraftValue; expectedSha256: string | null; confirm: string }): Promise<{ sha256: string }>;
  setClientPool(input: { schemaVersion: 1; target: TargetValue; client: string; pool: PeerPoolValue; expectedSha256: string | null; confirm: string }): Promise<{ sha256: string }>;
  setClientProtocol(input: { schemaVersion: 1; target: TargetValue; client: string; text: string; expectedSha256: string | null; confirm: string }): Promise<{ sha256: string }>;
  /** Workspaces the connected Paseo host knows (id, name, directory) with the Paseo PROJECT each belongs to. */
  listWorkspaces(): Promise<HostWorkspace[]>;
};
export type HostWorkspace = { id: string; name: string; directory: string; projectId?: string; projectLabel?: string; projectRootPath?: string; projectKind?: "git" | "directory" | "non_git"; workspaceKind?: "directory" | "local_checkout" | "checkout" | "worktree" };

/** One entry of `paseoApi.workspaces.list()` (the host's workspace descriptor) → what the screen needs.
 * `name` is the WORKSPACE name (usually a task title); the project is `projectDisplayName` ("Cliente / projeto"),
 * `projectRootPath` and `projectKind`. An entry without a directory cannot be bound and is skipped. */
export function workspaceOfEntry(entry: unknown): HostWorkspace[] {
  if (entry === null || typeof entry !== "object") return [];
  const d = entry as Record<string, unknown>;
  const directory = typeof d.workspaceDirectory === "string" ? d.workspaceDirectory : typeof d.directory === "string" ? d.directory : null;
  if (typeof d.id !== "string" || directory === null) return [];
  const label = typeof d.projectCustomName === "string" && d.projectCustomName.trim() ? d.projectCustomName : typeof d.projectDisplayName === "string" ? d.projectDisplayName : "";
  const kind = d.workspaceKind ?? d.kind;
  return [{
    id: d.id, name: typeof d.name === "string" ? d.name : directory, directory,
    ...(typeof d.projectId === "string" && label ? { projectId: d.projectId, projectLabel: label } : {}),
    ...(typeof d.projectRootPath === "string" && d.projectRootPath.startsWith("/") ? { projectRootPath: d.projectRootPath } : {}),
    ...(d.projectKind === "git" || d.projectKind === "directory" || d.projectKind === "non_git" ? { projectKind: d.projectKind } : {}),
    ...(kind === "directory" || kind === "local_checkout" || kind === "checkout" || kind === "worktree" ? { workspaceKind: kind } : {}),
  }];
}
/** "CemigSim / client-area-api" → "CemigSim": only a SUGGESTION of the client (matched, case-insensitively, against the map's clients). */
export function suggestedClientOf(label: string | null, clients: string[]): string | null {
  const prefix = label?.split(" / ")[0]?.trim().toLowerCase();
  return prefix ? clients.find(name => name.toLowerCase() === prefix) ?? null : null;
}

/** Values the screen SUGGESTS for a new map. They live in the draft only: nothing is written until the Human reviews and confirms.
 * No commit identity is suggested (no personal name or e-mail ships in this repository): the Human defines it, per client or globally. */
export const SUGGESTED_RULES: ClientRulesDraftValue = {
  titleFormat: "origin-id - pt-title",
  aiFooter: "forbid",
};
/** A map created on this screen is version 2 and strict: a project without a client is blocked until bound. */
export const emptyClientsMap = (): ClientsMapDraftValue => ({ version: 2, strict: true, protectedRoots: [], rules: JSON.parse(JSON.stringify(SUGGESTED_RULES)), clients: {}, repositories: [] });
export type RuleKey = "commitIdentity" | "titleFormat" | "aiFooter" | "origin";
/** Version 2 features (strict, rules, local-only) need the version 2 file; a version 1 draft is converted, keeping strict off. */
const ensureV2 = (map: ClientsMapDraftValue) => { if (map.version !== 2) { map.version = 2; map.strict = map.strict ?? false; } };
/** An existing entry whose repository no longer matches it (origin changed, or local-only that gained a remote). */
const drifted = (row: ClientProjectRowValue) => row.state === "blocked" && row.code === "CLIENT_IDENTITY_DRIFT" && row.client !== null && row.gitCommonDir !== null && (row.originSha256 !== null || row.localOnly);
/** A plain bind never touches a drifted row: re-fixing the identity is a separate, explicit action. */
const bindable = (row: ClientProjectRowValue, folders = false) => row.kind === "folder"
  // A project root without Git binds as a container, and only when the server says the bound runtime can read it back.
  ? folders && row.containerBlocked === null && row.mainPath !== null && row.code !== "CLIENT_MAP_INVALID" && row.state !== "blocked"
  : row.gitCommonDir !== null && (row.originSha256 !== null || row.localOnly) && row.code !== "CLIENT_MAP_INVALID" && row.state !== "not-git" && !drifted(row);
const shortOrigin = (origin: string | null) => (origin === null ? "local-only" : `${origin.slice(0, 12)}…`);
const clone = (map: ClientsMapDraftValue): ClientsMapDraftValue => JSON.parse(JSON.stringify(map));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isCas = (message: string) => /changed since it was read|IDEMPOTENCY_CONFLICT/.test(message);

type Review = { forDraft: string; result: ValidateClientsDraftResult };
type MapDraft = { map: ClientsMapDraftValue; baseSha: string | null; review: Review | null; conflict: boolean };
type ProtocolDraft = { text: string; baseSha: string | null; review: Review | null; conflict: boolean };

export function useClientsCard({ target, targetKey, api, update }: {
  target: TargetValue | null;
  targetKey: string | null;
  api: ClientsApi;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  const snapshot = useTargetSnapshot(target, targetKey, t => api.getClients({ schemaVersion: 1, target: t }), "clients");
  const { data, error: readError, capture } = snapshot;
  // Drafts survive switching hosts and coming back; each target owns its own.
  const mapDrafts = useRef(new Map<string, MapDraft>());
  const protocolDrafts = useRef(new Map<string, ProtocolDraft>());
  const [, rerender] = useState(0);
  const touch = () => rerender(n => n + 1);
  const [selected, setSelectedRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Pool editors are mounted per opened client by the shell; a pool review
  // (first Save press) belongs to one target, one client and one reviewed pool,
  // so it dies with the target and with any change of the open client.
  const [opened, setOpened] = useState<string[]>([]);
  const poolReviews = useRef(new Map<string, string>());
  const [poolImpact, setPoolImpact] = useState<{ client: string; result: ValidateClientsDraftResult } | null>(null);
  useEffect(() => {
    setSelectedRaw(null); setOpened([]); poolReviews.current.clear(); setPoolImpact(null);
    setBusy(false); setNotice(null); setErrorText(null); setCandidate(null); setExplained(null);
    setProjects(null); setPicked([]); setBindTo(null); setProposed(null); setCoverOk([]);
  }, [targetKey]);

  const draft = targetKey ? mapDrafts.current.get(targetKey) ?? null : null;
  const map = draft?.map ?? data?.map ?? emptyClientsMap();
  const baseSha = draft ? draft.baseSha : data?.mapSha256 ?? null;
  const dirty = draft !== null;
  const setSelected = (name: string | null) => {
    setSelectedRaw(name); setNotice(null); setErrorText(null);
    poolReviews.current.clear(); setPoolImpact(null);
    if (name !== null) setOpened(list => (list.includes(name) ? list : [...list, name]));
  };

  const edit = (change: (next: ClientsMapDraftValue) => void) => {
    if (!targetKey || busy) return;
    const next = clone(map);
    change(next);
    mapDrafts.current.set(targetKey, { map: next, baseSha, review: null, conflict: draft?.conflict ?? false });
    setNotice(null); setErrorText(null); touch();
  };
  const discard = () => { if (targetKey) mapDrafts.current.delete(targetKey); setNotice(null); setErrorText(null); touch(); };

  const run = async <T,>(work: () => Promise<T>): Promise<T | null> => {
    if (!target || !targetKey) return null;
    const ticket = capture();
    setBusy(true); setErrorText(null);
    try { const out = await work(); return ticket.isCurrent() ? out : null; }
    catch (cause) { if (ticket.isCurrent()) { setErrorText(errorMessage(cause)); update({ lastError: errorMessage(cause) }, target); } return null; }
    finally { if (ticket.isCurrent()) setBusy(false); }
  };

  // ---- map: review (server validation + impact) then confirm save --------
  const reviewMap = async () => {
    if (!target || !targetKey || !draft) return;
    const forDraft = JSON.stringify(draft.map);
    const result = await run(() => api.validate({ schemaVersion: 1, target, draft: { kind: "map", map: draft.map } }));
    const current = mapDrafts.current.get(targetKey);
    if (result && current && JSON.stringify(current.map) === forDraft) { mapDrafts.current.set(targetKey, { ...current, review: { forDraft, result } }); touch(); }
  };
  const saveMap = async () => {
    if (!target || !targetKey || !draft?.review?.result.ok || !draft.review.result.confirm || draft.review.forDraft !== JSON.stringify(draft.map)) return;
    const { confirm } = draft.review.result;
    const body = draft.map; const expected = draft.baseSha;
    const saved = await run(async () => {
      try { return await api.setClients({ schemaVersion: 1, target, map: body, expectedSha256: expected, confirm }); }
      catch (cause) {
        if (isCas(errorMessage(cause))) { const current = mapDrafts.current.get(targetKey); if (current) mapDrafts.current.set(targetKey, { ...current, conflict: true, review: null }); touch(); }
        throw cause;
      }
    });
    if (saved) { mapDrafts.current.delete(targetKey); setNotice("Map saved. The new map hash applies to the next seat formation."); await snapshot.reload(target); await loadProjects(); touch(); }
  };
  const rebase = async () => {
    if (!target || !targetKey || !draft) return;
    const latest = await run(() => api.getClients({ schemaVersion: 1, target }));
    if (!latest) return;
    mapDrafts.current.set(targetKey, { ...draft, baseSha: latest.mapSha256, conflict: false, review: null });
    await snapshot.reload(target); setNotice("Latest map loaded. Your draft is kept and will replace it on save."); touch();
  };

  // ---- draft operations --------------------------------------------------
  const addClient = (name: string, directory: string) => {
    if (!NAME.test(name) || !NAME.test(directory) || directory.includes("..")) { setErrorText("Client name and directory need 1-64 letters, digits, dot, dash or underscore."); return false; }
    if (Object.hasOwn(map.clients, name)) { setErrorText("A client with this name already exists."); return false; }
    edit(next => { next.clients[name] = { directory }; });
    return true;
  };
  const removeClient = (name: string) => { edit(next => { delete next.clients[name]; next.repositories = next.repositories.filter(entry => entry.client !== name); }); setOpened(list => list.filter(item => item !== name)); if (selected === name) setSelectedRaw(null); };
  const addRoot = (root: string) => { if (root.trim()) edit(next => { if (!next.protectedRoots.includes(root.trim())) next.protectedRoots.push(root.trim()); }); };
  const removeRoot = (root: string) => edit(next => { next.protectedRoots = next.protectedRoots.filter(item => item !== root); });
  const removeRepository = (index: number) => edit(next => { next.repositories.splice(index, 1); });
  const renameProject = (index: number, project: string) => edit(next => { if (next.repositories[index]) next.repositories[index]!.project = project; });

  // ---- version 2: strict mode and structured rules (draft only) ---------
  const setStrict = (value: boolean) => edit(next => { ensureV2(next); next.strict = value; });
  /** `scope` null = the global rules; a client name = that client's. `undefined` drops the key (client: inherit), `null` switches it off (client only). */
  const setRule = (scope: string | null, key: RuleKey, value: unknown) => edit(next => {
    ensureV2(next);
    const holder: Record<string, unknown> | null = scope === null ? (next.rules ??= {}) : next.clients[scope] ? (next.clients[scope]!.rules ??= {}) : null;
    if (holder === null) return;
    if (value === undefined) delete holder[key]; else holder[key] = value;
    if (Object.keys(holder).length === 0) { if (scope === null) delete next.rules; else delete next.clients[scope]!.rules; }
  });

  // ---- every Paseo project and its client (list + individual/batch bind) ---
  const [projects, setProjects] = useState<ListClientProjectsResult | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [bindTo, setBindTo] = useState<string | null>(null);
  async function loadProjects() {
    if (!target || !targetKey) return;
    const list = await run(() => api.listWorkspaces());
    if (!list) return;
    const found = await run(() => api.listProjects({ schemaVersion: 1, target, workspaces: list.map(({ directory, ...rest }) => ({ ...rest, path: directory })) }));
    if (found) { setProjects(found); setPicked(keys => keys.filter(key => found.projects.some(row => row.key === key))); }
  }
  // The list shows the DRAFT binding next to the saved one, so a batch bind is visible before it is saved.
  const projectRows = (projects?.projects ?? []).map(row => {
    const entry = row.kind === "folder" ? map.containers?.find(item => item.path === row.mainPath)
      : row.gitCommonDir === null ? undefined : map.repositories.find(item => item.gitCommonDir === row.gitCommonDir);
    const saved = row.state === "bound" ? row.client : null;
    return { ...row, draftClient: entry?.client ?? null, changed: (entry?.client ?? null) !== saved,
      // Only a hint taken from "Client / project"; it binds nothing.
      suggestedClient: row.projects.map(project => suggestedClientOf(project.label, Object.keys(map.clients))).find(name => name !== null) ?? null };
  });
  const containerOk = data?.containerWrites?.allowed === true;
  const canBind = (row: ClientProjectRowValue) => bindable(row, containerOk);
  // A folder's "covers": the other projects (folders and repositories) below it. A Git repository is never covered, but the Human must see the overlap.
  const coversOf = (row: ClientProjectRowValue) => row.kind !== "folder" || row.mainPath === null ? 0
    : projectRows.filter(other => other.key !== row.key && other.mainPath !== null && other.mainPath.startsWith(`${row.mainPath}/`)).length
      + (map.containers ?? []).filter(item => item.path !== row.mainPath && item.path.startsWith(`${row.mainPath}/`) && !projectRows.some(other => other.mainPath === item.path)).length;
  const [coverOk, setCoverOk] = useState<string[]>([]);
  const confirmCover = (key: string) => setCoverOk(keys => (keys.includes(key) ? keys : [...keys, key]));
  const pendingInDraft = projectRows.filter(row => (row.kind === "folder" ? row.containerBlocked === null && row.state !== "blocked" : row.gitCommonDir !== null) && row.draftClient === null).length;
  const pickProject = (key: string, on: boolean) => {
    setPicked(keys => on ? (keys.includes(key) ? keys : [...keys, key]) : keys.filter(item => item !== key));
    // Pre-select (never bind) the client suggested by the project label when none is chosen yet.
    const suggested = projectRows.find(row => row.key === key)?.suggestedClient ?? null;
    if (on && suggested !== null) setBindTo(current => current ?? suggested);
  };
  const pickPending = () => setPicked(projectRows.filter(row => canBind(row) && row.draftClient === null && coversOf(row) === 0).map(row => row.key));
  const bindProjects = (keys: string[], client: string | null) => {
    if (client === null || !Object.hasOwn(map.clients, client)) { setErrorText("Choose the client to bind to first."); return; }
    const rows = keys.map(key => projectRows.find(row => row.key === key)).filter((row): row is NonNullable<typeof row> => row !== undefined && canBind(row));
    if (rows.length === 0) { setErrorText("None of the selected projects can be bound."); return; }
    // A folder that sits above other projects needs its own explicit confirmation first.
    const unconfirmed = rows.filter(row => coversOf(row) > 0 && !coverOk.includes(row.key));
    const ready = rows.filter(row => !unconfirmed.includes(row));
    if (unconfirmed.length > 0) setErrorText("A folder that contains other projects needs its separate confirmation before it is bound.");
    if (ready.length === 0) return;
    edit(next => {
      for (const row of ready) {
        if (row.kind === "folder") {
          ensureV2(next);
          next.containers ??= [];
          const index = next.containers.findIndex(item => item.path === row.mainPath);
          const entry = { client, project: index >= 0 ? next.containers[index]!.project : row.projectLabel ?? row.repoName, path: row.mainPath! };
          if (index >= 0) next.containers[index] = entry; else next.containers.push(entry);
          continue;
        }
        const index = next.repositories.findIndex(item => item.gitCommonDir === row.gitCommonDir);
        const entry = { client, project: index >= 0 ? next.repositories[index]!.project : row.projectSuggestion, gitCommonDir: row.gitCommonDir!, originSha256: row.originSha256 };
        if (entry.originSha256 === null) ensureV2(next);
        if (index >= 0) next.repositories[index] = entry; else next.repositories.push(entry);
      }
    });
    setPicked(keys => keys.filter(key => unconfirmed.some(row => row.key === key)));
  };
  // Drifted rows: propose (shows old -> new), then confirm; both only edit the draft.
  const [proposed, setProposed] = useState<string | null>(null);
  const identityChange = (key: string) => {
    const row = projectRows.find(item => item.key === key);
    const entry = row?.gitCommonDir ? map.repositories.find(item => item.gitCommonDir === row.gitCommonDir) : undefined;
    return row && entry && drifted(row) ? { from: entry.originSha256, to: row.originSha256 } : null;
  };
  const proposeIdentity = (key: string) => { if (identityChange(key)) setProposed(key); };
  const cancelIdentity = () => setProposed(null);
  const acceptIdentity = (key: string) => {
    const change = identityChange(key);
    const row = projectRows.find(item => item.key === key);
    if (!change || !row || proposed !== key) return;
    edit(next => {
      const index = next.repositories.findIndex(item => item.gitCommonDir === row.gitCommonDir);
      if (index < 0) return;
      if (change.to === null) ensureV2(next);
      next.repositories[index] = { ...next.repositories[index]!, originSha256: change.to };
    });
    setProposed(null);
  };
  const unbindProject = (key: string) => {
    const row = projectRows.find(item => item.key === key);
    if (row?.kind === "folder") { edit(next => { if (next.containers) { next.containers = next.containers.filter(item => item.path !== row.mainPath); if (next.containers.length === 0) delete next.containers; } }); setCoverOk(keys => keys.filter(item => item !== key)); }
    else if (row?.gitCommonDir) edit(next => { next.repositories = next.repositories.filter(item => item.gitCommonDir !== row.gitCommonDir); });
  };
  useEffect(() => { if (target && targetKey && snapshot.loaded) void loadProjects(); }, [targetKey, snapshot.loaded]);

  // ---- repositories: identity is computed by the server -----------------
  const [candidate, setCandidate] = useState<(IdentifyRepositoryResult & { path: string }) | null>(null);
  const [workspaces, setWorkspaces] = useState<HostWorkspace[] | null>(null);
  const [project, setProject] = useState("");
  const identify = async (path: string) => {
    if (!target || !path.trim()) return;
    const found = await run(() => api.identify({ schemaVersion: 1, target, path: path.trim() }));
    if (found) { setCandidate({ ...found, path: path.trim() }); setProject(found.projectSuggestion); setNotice(null); }
  };
  const loadWorkspaces = async () => { const list = await run(() => api.listWorkspaces()); if (list) setWorkspaces(list); };
  const addCandidate = () => {
    if (!candidate || !selected || candidate.mappedClient !== null || !project.trim()) return;
    edit(next => {
      if (candidate.originSha256 === null) ensureV2(next);
      next.repositories.push({ client: selected, project: project.trim(), gitCommonDir: candidate.gitCommonDir, originSha256: candidate.originSha256 });
    });
    setCandidate(null);
  };

  // ---- diagnosis: who resolves this repository ---------------------------
  const [explained, setExplained] = useState<ExplainResolutionResult | null>(null);
  const explain = async (path: string) => {
    if (!target || !path.trim()) return;
    const result = await run(() => api.explain({ schemaVersion: 1, target, path: path.trim() }));
    if (result) setExplained(result);
  };

  // ---- protocol of the selected client ----------------------------------
  const filesKey = targetKey && selected ? `${targetKey}|${selected}` : null;
  const files = useTargetSnapshot(selected ? target : null, filesKey, t => api.getClientFiles({ schemaVersion: 1, target: t, client: selected! }), "client-files");
  const protocolDraft = filesKey ? protocolDrafts.current.get(filesKey) ?? null : null;
  const protocolText = protocolDraft?.text ?? files.data?.protocol.text ?? "";
  const protocolBase = protocolDraft ? protocolDraft.baseSha : files.data?.protocol.sha256 ?? null;
  const setProtocolText = (text: string) => { if (filesKey) { protocolDrafts.current.set(filesKey, { text, baseSha: protocolBase, review: null, conflict: protocolDraft?.conflict ?? false }); touch(); } };
  const reviewProtocol = async () => {
    if (!target || !selected || !filesKey || !protocolDraft) return;
    const forDraft = protocolDraft.text;
    const result = await run(() => api.validate({ schemaVersion: 1, target, draft: { kind: "protocol", client: selected, text: forDraft } }));
    const current = protocolDrafts.current.get(filesKey);
    if (result && current && current.text === forDraft) { protocolDrafts.current.set(filesKey, { ...current, review: { forDraft, result } }); touch(); }
  };
  const saveProtocol = async () => {
    if (!target || !selected || !filesKey || !protocolDraft?.review?.result.ok || !protocolDraft.review.result.confirm || protocolDraft.review.forDraft !== protocolDraft.text) return;
    const { confirm } = protocolDraft.review.result; const text = protocolDraft.text; const expected = protocolDraft.baseSha;
    const saved = await run(async () => {
      try { return await api.setClientProtocol({ schemaVersion: 1, target, client: selected, text, expectedSha256: expected, confirm }); }
      catch (cause) {
        if (isCas(errorMessage(cause))) { const current = protocolDrafts.current.get(filesKey); if (current) protocolDrafts.current.set(filesKey, { ...current, conflict: true, review: null }); touch(); }
        throw cause;
      }
    });
    if (saved) { protocolDrafts.current.delete(filesKey); setNotice("Protocol saved."); await files.reload(target); await snapshot.reload(target); touch(); }
  };
  const discardProtocol = () => { if (filesKey) { protocolDrafts.current.delete(filesKey); touch(); } };
  const rebaseProtocol = async () => {
    if (!target || !filesKey || !protocolDraft) return;
    const latest = await files.reload(target);
    if (latest && latest.ok) { protocolDrafts.current.set(filesKey, { ...protocolDraft, baseSha: latest.data.protocol.sha256, conflict: false, review: null }); setNotice("Latest protocol loaded. Your draft is kept and will replace it on save."); touch(); }
  };

  // ---- adapters for the Peer pool editor of ONE client ------------------
  // First Save press reviews (server validation + impact, shown by the card);
  // the second press with an unchanged pool sends the server's confirm token.
  // Each adapter is bound to its client, so a pool never crosses clients.
  const poolAdaptersFor = (client: string) => ({
    get: async (input: GetPeerPoolRequest): Promise<GetPeerPoolResult> => {
      const found = await api.getClientFiles({ schemaVersion: 1, target: input.target, client });
      return { schemaVersion: 1, pool: found.pool.pool, sha256: found.pool.sha256, error: found.pool.error, legacy: null, legacyError: null };
    },
    set: async (input: SetPeerPoolRequest): Promise<SetPeerPoolResult> => {
      const checked = await api.validate({ schemaVersion: 1, target: input.target, draft: { kind: "pool", client, pool: input.pool } });
      setPoolImpact({ client, result: checked });
      if (!checked.ok || checked.confirm === null) throw new Error(checked.errors.join("; ") || "The pool is not valid.");
      if (poolReviews.current.get(client) !== checked.confirm) {
        poolReviews.current.clear(); poolReviews.current.set(client, checked.confirm);
        throw new Error("Review the impact shown above, then press Save again to confirm.");
      }
      try {
        const saved = await api.setClientPool({ schemaVersion: 1, target: input.target, client, pool: input.pool, expectedSha256: input.expectedSha256, confirm: checked.confirm });
        poolReviews.current.delete(client); setPoolImpact(null); void snapshot.reload(input.target);
        return { schemaVersion: 1, pool: input.pool, sha256: saved.sha256 };
      } catch (cause) { throw new Error(isCas(errorMessage(cause)) ? "peer pool changed since it was read — reload before saving" : errorMessage(cause)); }
    },
  });

  return { data, readError, loaded: snapshot.loaded, fresh: snapshot.fresh, reload: () => (target ? snapshot.reload(target) : Promise.resolve(null)),
    map, baseSha, dirty, draft, selected, setSelected, busy, notice, errorText, edit, discard,
    reviewMap, saveMap, rebase, addClient, removeClient, addRoot, removeRoot, removeRepository, renameProject,
    candidate, setCandidate, project, setProject, identify, loadWorkspaces, workspaces, addCandidate,
    setStrict, setRule, projects, projectRows, pendingInDraft, picked, pickProject, pickPending, setPicked, canBind, coversOf, coverOk, confirmCover, containerOk, proposed, identityChange, proposeIdentity, cancelIdentity, acceptIdentity, bindTo, setBindTo, bindProjects, unbindProject, loadProjects,
    explained, explain, files, protocolText, protocolDraft, setProtocolText, reviewProtocol, saveProtocol, discardProtocol, rebaseProtocol,
    opened, poolAdaptersFor, poolImpact };
}
export type ClientsCardState = ReturnType<typeof useClientsCard>;

const wrap = { flexWrap: "wrap" as const };

function ImpactBox({ colors, review, scope }: { colors: Colors; review: ValidateClientsDraftResult; scope: "map" | "client" }) {
  const affected = review.affectedClients.join(", ");
  return (
    <View style={[styles.confirmBox, { borderColor: colors.border }]}>
      {review.errors.map((line, index) => <Text key={`e${index}`} style={{ color: colors.statusWarning }} selectable>{line}</Text>)}
      {review.warnings.map((line, index) => <Text key={`w${index}`} style={[styles.mutedSmall, { color: colors.foregroundMuted }]} selectable>{line}</Text>)}
      {review.ok ? (
        <>
          <Text style={[styles.mutedSmall, { color: colors.foreground }]}>
            Saving changes file hashes. Seats already running for the clients below will report ROUTE_DRIFT at their next step:
          </Text>
          <Text style={[styles.mutedSmall, styles.mono, { color: colors.foreground }]} selectable>{affected || "none"}</Text>
          {scope === "map" && review.mapHashChanges ? (
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              The map hash is part of every central pin, so seats of all central clients are affected, not only the clients listed.
            </Text>
          ) : null}
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            After saving, read the routes again and repeat the request with a new requestId.
          </Text>
          <KV colors={colors} label="Confirmation" value={`${review.confirm?.slice(0, 12) ?? ""}…`} />
        </>
      ) : null}
    </View>
  );
}


const ORIGIN_KINDS = [{ label: "Azure DevOps", value: "azure" }, { label: "Jira", value: "jira" }, { label: "GitLab", value: "gitlab" }, { label: "GitHub", value: "github" }] as const;
const originFields = (kind: string): { key: string; label: string }[] => kind === "azure" ? [{ key: "organization", label: "Organization" }, { key: "project", label: "Project" }]
  : kind === "jira" ? [{ key: "site", label: "Site" }] : kind === "gitlab" ? [{ key: "group", label: "Group" }] : [{ key: "owner", label: "Owner" }];

/** The structured rules of the global scope (`scope` null) or of one client. A
 * client key can inherit the global value, override it or switch it off. Text
 * and enums only; the server validates every value again at review. */
function RulesEditor({ colors, scope, rules, disabled, onChange }: {
  colors: Colors; scope: string | null; rules: ClientRulesDraftValue | undefined; disabled: boolean;
  onChange: (key: RuleKey, value: unknown) => void;
}) {
  const client = scope !== null;
  const current = rules ?? {};
  const mode = (key: RuleKey) => current[key] === undefined ? "inherit" : current[key] === null ? "off" : "set";
  const identity = (current.commitIdentity ?? null) as { name: string; email: string } | null;
  const origin = (current.origin ?? null) as ({ kind: string } & Record<string, string>) | null;
  const row = (key: RuleKey, title: string, editor: React.ReactNode, initial: unknown) => (
    <View style={[styles.confirmBox, { borderColor: colors.border }]} key={key}>
      <Text style={[styles.fieldLabel, { color: colors.foreground }]}>{title}</Text>
      <View style={[styles.chipRow, wrap]}>
        <Badge colors={colors} label={mode(key) === "set" ? "Defined here" : mode(key) === "off" ? "Switched off" : client ? "Inherited" : "Not set"} tone={mode(key) === "set" ? "good" : "neutral"} />
        <Button colors={colors} label={mode(key) === "set" ? "Change" : "Define"} disabled={disabled} onPress={() => { if (mode(key) !== "set") onChange(key, initial); }} />
        {client ? <Button colors={colors} label="Inherit" disabled={disabled || mode(key) === "inherit"} onPress={() => onChange(key, undefined)} /> : null}
        {client ? <Button colors={colors} label="Switch off" disabled={disabled || mode(key) === "off"} onPress={() => onChange(key, null)} /> : <Button colors={colors} label="Remove" disabled={disabled || mode(key) !== "set"} onPress={() => onChange(key, undefined)} />}
      </View>
      {mode(key) === "set" ? editor : null}
    </View>
  );
  return (
    <View style={styles.field}>
      {row("commitIdentity", "Commit identity", (
        <>
          <Field colors={colors} label="Commit name" value={identity?.name ?? ""} disabled={disabled} onChangeText={name => onChange("commitIdentity", { name, email: identity?.email ?? "" })} />
          <Field colors={colors} label="Commit e-mail" value={identity?.email ?? ""} disabled={disabled} onChangeText={email => onChange("commitIdentity", { name: identity?.name ?? "", email })} />
        </>
      ), { name: "", email: "" })}
      {row("titleFormat", "Title format", <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Task, PR and task-commit titles read: origin ID - title in Portuguese.</Text>, "origin-id - pt-title")}
      {row("aiFooter", "AI footer", (
        <ChipSelect colors={colors} value={(current.aiFooter as string) ?? "forbid"} disabled={disabled} variant="choice"
          options={[{ label: "Forbidden", value: "forbid" }, { label: "Allowed", value: "allow" }]} onChange={value => onChange("aiFooter", value)} />
      ), "forbid")}
      {client ? row("origin", "Task origin (informational)", (
        <>
          <ChipSelect colors={colors} value={origin?.kind ?? "azure"} disabled={disabled} variant="choice" options={ORIGIN_KINDS}
            onChange={kind => onChange("origin", { kind })} />
          {originFields(origin?.kind ?? "azure").map(field => (
            <Field key={field.key} colors={colors} label={field.label} value={origin?.[field.key] ?? ""} disabled={disabled}
              onChangeText={text => onChange("origin", { ...(origin ?? { kind: "azure" }), [field.key]: text })} />
          ))}
        </>
      ), { kind: "azure", organization: "", project: "" }) : null}
    </View>
  );
}

const STATE_LABEL: Record<ClientProjectRowValue["state"], string> = { bound: "Bound", pending: "No client", blocked: "Blocked", "not-git": "Not a Git repository" };
function ProjectsSection({ colors, s, disabled }: { colors: Colors; s: ClientsCardState; disabled: boolean }) {
  const names = Object.keys(s.map.clients).sort();
  const rows = s.projectRows;
  // One group per Paseo project; a project with several repositories shows one row per repository under it.
  const groups: { id: string; label: string; rows: typeof rows }[] = [];
  for (const row of rows) {
    const id = row.projectId ?? row.key;
    const found = groups.find(group => group.id === id);
    if (found) found.rows.push(row); else groups.push({ id, label: row.projectLabel ?? row.name, rows: [row] });
  }
  return (
    <View style={styles.field}>
      <View style={[styles.chipRow, wrap]}>
        <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Paseo projects</Text>
        {s.projects ? <Badge colors={colors} label={s.projects.pending > 0 ? `${s.projects.pending} without a client` : "All bound"} tone={s.projects.pending > 0 ? "draft" : "good"} /> : null}
      </View>
      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Every project the host lists, collapsed by repository. A project without a client is never blocked from being created; a strict map blocks seats and agents for it until it is bound here.</Text>
      {s.map.strict === true && s.pendingInDraft > 0 ? <Text style={{ color: colors.statusWarning }} accessibilityLiveRegion="polite">{`Strict mode is on and ${s.pendingInDraft} project(s) have no client in this draft.`}</Text> : null}
      <View style={[styles.chipRow, wrap]}>
        <Button colors={colors} label="Reload projects" disabled={disabled} onPress={() => void s.loadProjects()} />
        <Button colors={colors} label="Select all without a client" disabled={disabled || rows.length === 0} onPress={s.pickPending} />
        <Button colors={colors} label="Clear selection" disabled={disabled || s.picked.length === 0} onPress={() => s.setPicked([])} />
      </View>
      {names.length === 0 ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Add a client below to bind projects.</Text> : (
        <>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Bind to:</Text>
          <View style={[styles.chipRow, wrap]}>
            {names.map(name => <Button key={name} colors={colors} label={name} kind={s.bindTo === name ? "primary" : "ghost"} onPress={() => s.setBindTo(name)} />)}
          </View>
          <Button colors={colors} label="Bind selected to the chosen client" kind="primary" disabled={disabled || s.picked.length === 0 || s.bindTo === null} onPress={() => s.bindProjects(s.picked, s.bindTo)} />
        </>
      )}
      {rows.length === 0 ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>No projects listed yet.</Text> : null}
      {groups.map(group => (
        <View key={group.id} style={styles.field}>
          {group.rows.length > 1 ? (
            <View style={[styles.chipRow, wrap]}>
              <Text style={[styles.fieldLabel, { color: colors.foreground }]} selectable>{group.label}</Text>
              <Badge colors={colors} label={`${group.rows.length} repositories`} tone="neutral" />
            </View>
          ) : null}
          {group.rows.map(row => (
            <View key={row.key} style={[styles.roleBox, { borderColor: s.picked.includes(row.key) ? colors.accent : colors.border }]}>
              <View style={[styles.chipRow, wrap]}>
                <Button colors={colors} label={s.picked.includes(row.key) ? "Selected" : "Select"} kind={s.picked.includes(row.key) ? "primary" : "ghost"} disabled={disabled || !s.canBind(row)} onPress={() => s.pickProject(row.key, !s.picked.includes(row.key))} />
                <Text style={[styles.roleTitle, { color: colors.foreground }]} selectable>{group.rows.length > 1 ? row.repoName : row.name}</Text>
                <Badge colors={colors} label={STATE_LABEL[row.state]} tone={row.state === "bound" ? "good" : row.state === "pending" ? "draft" : row.state === "blocked" ? "bad" : "neutral"} />
                {row.localOnly ? <Badge colors={colors} label="Local only" tone="managed" /> : null}
                {row.changed ? <Badge colors={colors} label="Changed in draft" tone="draft" /> : null}
                {drifted(row) ? <Badge colors={colors} label="Identity drift" tone="bad" /> : null}
                {row.identity && row.identity.state !== "ok" ? <Badge colors={colors} label="Git identity differs" tone="bad" /> : null}
                {row.suggestedClient !== null && row.draftClient === null ? <Badge colors={colors} label={`Suggested client: ${row.suggestedClient}`} tone="managed" /> : null}
              </View>
              <KV colors={colors} label="Workspaces" value={String(row.workspaceCount)} />
              {row.mainPath ? <KV colors={colors} label={row.kind === "folder" ? "Project folder" : "Main checkout"} value={row.mainPath} /> : null}
              {row.kind === "folder" ? <Badge colors={colors} label="Folder without Git" tone="neutral" /> : null}
              {row.kind === "folder" && row.containerBlocked === null && !s.containerOk ? <Text style={[styles.mutedSmall, { color: colors.statusWarning }]} selectable>{s.data?.containerWrites?.reason ?? "Containers cannot be saved yet."}</Text> : null}
              {row.kind === "folder" && s.coversOf(row) > 0 && !s.coverOk.includes(row.key) && row.draftClient === null ? (
                <View style={[styles.confirmBox, { borderColor: colors.border }]}>
                  <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>{`This folder contains ${s.coversOf(row)} other project(s). It binds only non-Git directories; Git repositories inside keep their own binding.`}</Text>
                  <Button colors={colors} label="Confirm that this folder covers them" disabled={disabled || !s.canBind(row)} onPress={() => s.confirmCover(row.key)} />
                </View>
              ) : null}
              <KV colors={colors} label="Client" value={row.draftClient ?? row.client ?? "none"} />
              {row.projects.length > 1 ? <Text style={[styles.mutedSmall, { color: colors.statusWarning }]} selectable>{`Duplicate projects for one repository: ${row.projects.map(project => project.label).join(" | ")}. One binding covers them all.`}</Text> : null}
              {row.reason ? <Text style={[styles.mutedSmall, { color: colors.statusWarning }]} selectable>{row.reason}</Text> : null}
              {row.identity && row.identity.state !== "ok" ? (
                <View style={styles.field}>
                  <KV colors={colors} label="Git identity" value={row.identity.state} />
                  <Text style={[styles.mutedSmall, { color: colors.statusWarning }]} selectable>{`Rule: ${row.identity.expected.name} <${row.identity.expected.email}>`}</Text>
                  <Text style={[styles.mutedSmall, { color: colors.statusWarning }]} selectable>{`in Git: ${row.identity.effective.name ?? "unset"} <${row.identity.effective.email ?? "unset"}>`}</Text>
                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Read-only warning; nothing is changed.</Text>
                </View>
              ) : null}
              {drifted(row) ? (
                <View style={[styles.confirmBox, { borderColor: colors.border }]}>
                  <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>Binding does not re-fix a repository whose identity drifted. Accepting the new identity is a separate step and the review lists it.</Text>
                  {s.proposed === row.key && s.identityChange(row.key) ? (
                    <>
                      <KV colors={colors} label="Saved identity" value={shortOrigin(s.identityChange(row.key)!.from)} />
                      <KV colors={colors} label="New identity" value={shortOrigin(s.identityChange(row.key)!.to)} />
                      <View style={[styles.chipRow, wrap]}>
                        <Button colors={colors} label="Confirm the new identity" kind="primary" disabled={disabled} onPress={() => s.acceptIdentity(row.key)} />
                        <Button colors={colors} label="Cancel" disabled={disabled} onPress={s.cancelIdentity} />
                      </View>
                    </>
                  ) : <Button colors={colors} label="Accept the new identity" disabled={disabled} onPress={() => s.proposeIdentity(row.key)} />}
                </View>
              ) : null}
              <View style={[styles.chipRow, wrap]}>
                {row.suggestedClient !== null ? <Button colors={colors} label={`Bind to ${row.suggestedClient}`} disabled={disabled || !s.canBind(row)} onPress={() => s.bindProjects([row.key], row.suggestedClient)} /> : null}
                <Button colors={colors} label="Bind to the chosen client" disabled={disabled || s.bindTo === null || !s.canBind(row)} onPress={() => s.bindProjects([row.key], s.bindTo)} />
                <Button colors={colors} label="Remove binding from the draft" kind="danger" disabled={disabled || row.draftClient === null} onPress={() => s.unbindProject(row.key)} />
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function ClientsCard({ colors, compact, state, poolSlot }: {
  colors: Colors;
  compact: boolean;
  state: ClientsCardState;
  /** The Peer pool editor of the selected client (mounted by the shell). */
  poolSlot: React.ReactNode;
}) {
  const s = state;
  const [newName, setNewName] = useState("");
  const [newDirectory, setNewDirectory] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [path, setPath] = useState("");
  const rows = s.data?.clients ?? [];
  const names = Object.keys(s.map.clients).sort();
  const review = s.draft?.review?.result ?? null;
  const protocolReview = s.protocolDraft?.review?.result ?? null;
  const disabled = s.busy;
  const stateLabel = s.data?.mapState === "absent" && !s.dirty ? "No map" : s.dirty ? "Unsaved changes" : s.data?.mapState === "invalid" ? "Invalid map" : "Saved map";
  const tone = s.dirty ? "draft" : s.data?.mapState === "invalid" ? "bad" : s.data?.mapState === "valid" ? "good" : "neutral";
  return (
    <Card colors={colors} title="Clients"
      subtitle="Central map of repositories per client, with each client's own pool and protocol, kept outside the repositories. Nothing is created until you save."
      trailing={<Badge colors={colors} label={stateLabel} tone={tone} />}>
      {s.readError ? <Text style={{ color: colors.statusWarning }} selectable>{s.readError}</Text> : null}
      {s.errorText ? <Text style={{ color: colors.statusWarning }} accessibilityLiveRegion="polite" selectable>{s.errorText}</Text> : null}
      {s.notice ? <Text style={[styles.mutedSmall, { color: colors.foreground }]} accessibilityLiveRegion="polite">{s.notice}</Text> : null}
      {s.data?.mapError ? <Text style={{ color: colors.statusWarning }} selectable>{s.data.mapError}</Text> : null}
      {s.data?.hostErrors.map((line, index) => <Text key={`h${index}`} style={{ color: colors.statusWarning }} selectable>{line}</Text>)}
      {s.data?.mapExternalChange ? <Badge colors={colors} label="Map changed outside this screen" tone="draft" /> : null}
      {s.data ? <KV colors={colors} label="Map hash" value={s.data.mapSha256 ? `${s.data.mapSha256.slice(0, 12)}…` : "none"} /> : null}
      {s.data ? <KV colors={colors} label="Map version" value={s.data.map ? String(s.data.map.version) : "none"} /> : null}

      <SwitchRow colors={colors} checked={s.map.strict === true} disabled={disabled} onToggle={s.setStrict}
        title="Strict mode" hint="A project with no client is blocked at seat formation and at agent creation. Creating the project itself is never blocked." />

      <ProjectsSection colors={colors} s={s} disabled={disabled} />

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Global rules</Text>
        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Default for every client; a client may override or switch off each key. Identity and enums only — never client data.</Text>
        {s.map.rules?.commitIdentity === undefined ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>No commit identity is suggested: define it here for every client, or on each client.</Text> : null}
        <RulesEditor colors={colors} scope={null} rules={s.map.rules} disabled={disabled} onChange={(key, value) => s.setRule(null, key, value)} />
      </View>

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Protected folders</Text>
        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>A repository under these folders with no client entry is blocked, never given the user pool.</Text>
        {s.map.protectedRoots.map(root => (
          <View key={root} style={[styles.chipRow, wrap]}>
            <Text style={[styles.mutedSmall, styles.mono, { color: colors.foreground }]} selectable>{root}</Text>
            <Button colors={colors} label="Remove folder" kind="danger" disabled={disabled} onPress={() => s.removeRoot(root)} />
          </View>
        ))}
        <Field colors={colors} label="Add protected folder" placeholder="/absolute/path/to/clients-root" value={newRoot} onChangeText={setNewRoot} disabled={disabled} />
        <Button colors={colors} label="Add folder" disabled={disabled || !newRoot.trim()} onPress={() => { s.addRoot(newRoot); setNewRoot(""); }} />
      </View>

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Clients</Text>
        {names.length === 0 ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>No clients yet.</Text> : null}
        {names.map(name => {
          const row = rows.find(item => item.name === name);
          const count = s.map.repositories.filter(entry => entry.client === name).length;
          return (
            <View key={name} style={[styles.roleBox, { borderColor: s.selected === name ? colors.accent : colors.border }]}>
              <View style={[styles.chipRow, wrap]}>
                <Text style={[styles.roleTitle, { color: colors.foreground }]}>{name}</Text>
                {row?.error ? <Badge colors={colors} label="Needs attention" tone="bad" /> : row ? <Badge colors={colors} label="Ready" tone="good" /> : <Badge colors={colors} label="New in draft" tone="draft" />}
                {row?.externalChange ? <Badge colors={colors} label="Changed outside this screen" tone="draft" /> : null}
              </View>
              <KV colors={colors} label="Directory" value={s.map.clients[name]!.directory} />
              <KV colors={colors} label="Repositories" value={String(count)} />
              {row?.error ? <Text style={{ color: colors.statusWarning }} selectable>{row.error}</Text> : null}
              <View style={[styles.chipRow, wrap]}>
                <Button colors={colors} label={s.selected === name ? "Close client" : "Open client"} onPress={() => s.setSelected(s.selected === name ? null : name)} />
                <Button colors={colors} label="Remove client and its repositories" kind="danger" disabled={disabled} onPress={() => s.removeClient(name)} />
              </View>
            </View>
          );
        })}
        <Field colors={colors} label="New client name" value={newName} onChangeText={setNewName} disabled={disabled} />
        <Field colors={colors} label="Client folder name" hint="One folder under slp-clients/clients; letters, digits, dot, dash, underscore." value={newDirectory} onChangeText={setNewDirectory} disabled={disabled} />
        <Button colors={colors} label="Add client" disabled={disabled || !newName.trim()} onPress={() => { if (s.addClient(newName.trim(), (newDirectory.trim() || newName.trim()))) { setNewName(""); setNewDirectory(""); } }} />
      </View>

      {s.selected ? (
        <View style={[styles.roleBox, { borderColor: colors.border }]}>
          <Text style={[styles.roleTitle, { color: colors.foreground }]}>{s.selected}</Text>
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Client rules</Text>
          <RulesEditor colors={colors} scope={s.selected} rules={s.map.clients[s.selected]?.rules} disabled={disabled} onChange={(key, value) => s.setRule(s.selected, key, value)} />
          {s.data?.clients.find(item => item.name === s.selected)?.rulesText ? (
            <View style={[styles.confirmBox, { borderColor: colors.border }]}>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>What this client's agents receive (saved map):</Text>
              <Text style={[styles.mutedSmall, styles.mono, { color: colors.foreground }]} selectable>{s.data?.clients.find(item => item.name === s.selected)?.rulesText ?? ""}</Text>
            </View>
          ) : null}
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Repositories</Text>
          {s.map.repositories.map((entry, index) => entry.client !== s.selected ? null : (
            <View key={`${entry.gitCommonDir}`} style={styles.field}>
              <Field colors={colors} label="Project" value={entry.project} onChangeText={text => s.renameProject(index, text)} disabled={disabled} />
              <KV colors={colors} label="Git common dir" value={entry.gitCommonDir} />
              {entry.originSha256 === null ? <Badge colors={colors} label="Local only" tone="managed" /> : <KV colors={colors} label="Origin hash" value={`${entry.originSha256.slice(0, 16)}…`} />}
              <Button colors={colors} label="Remove repository" kind="danger" disabled={disabled} onPress={() => s.removeRepository(index)} />
            </View>
          ))}
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Add a repository</Text>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>The server reads the common dir and the origin hash from Git; you never type them.</Text>
          <Button colors={colors} label="Load Paseo projects" disabled={disabled} onPress={s.loadWorkspaces} />
          {(s.workspaces ?? []).map(workspace => (
            <View key={workspace.id} style={[styles.chipRow, wrap]}>
              <Text style={[styles.mutedSmall, { color: colors.foreground }]} selectable>{workspace.projectLabel ?? workspace.name}</Text>
              <Button colors={colors} label="Use this project" disabled={disabled} onPress={() => { setPath(workspace.directory); void s.identify(workspace.directory); }} />
            </View>
          ))}
          <Field colors={colors} label="Repository folder" placeholder="/absolute/path/to/repository" value={path} onChangeText={setPath} disabled={disabled} />
          <View style={[styles.chipRow, wrap]}>
            <Button colors={colors} label="Identify repository" disabled={disabled || !path.trim()} onPress={() => void s.identify(path)} />
            <Button colors={colors} label="Who resolves this folder?" disabled={disabled || !path.trim()} onPress={() => void s.explain(path)} />
          </View>
          {s.candidate ? (
            <View style={[styles.confirmBox, { borderColor: colors.border }]}>
              <KV colors={colors} label="Git common dir" value={s.candidate.gitCommonDir} />
              {s.candidate.originSha256 === null ? <Badge colors={colors} label="Local only" tone="managed" /> : <KV colors={colors} label="Origin hash" value={`${s.candidate.originSha256.slice(0, 16)}…`} />}
              <KV colors={colors} label="Linked worktree" value={s.candidate.linked ? "yes" : "no"} />
              {s.candidate.mappedClient ? <Text style={{ color: colors.statusWarning }}>Already mapped to a client; remove it there first.</Text> : null}
              <Field colors={colors} label="Project" value={s.project} onChangeText={s.setProject} disabled={disabled} />
              <Button colors={colors} label="Add to draft" kind="primary" disabled={disabled || s.candidate.mappedClient !== null || !s.project.trim()} onPress={s.addCandidate} />
            </View>
          ) : null}
          {s.explained ? (
            <View style={[styles.confirmBox, { borderColor: colors.border }]}>
              <KV colors={colors} label="Seat formation" value={s.explained.formation} />
              <KV colors={colors} label="Pool read as" value={s.explained.catalogScope ?? "unavailable"} />
              <KV colors={colors} label="Decided by" value={s.explained.decidedBy} />
              {s.explained.client ? <KV colors={colors} label="Client" value={s.explained.client} /> : null}
              {s.explained.code ? <KV colors={colors} label="Block code" value={s.explained.code} /> : null}
              {s.explained.strict !== null ? <KV colors={colors} label="Strict map" value={s.explained.strict ? "yes" : "no"} /> : null}
              {s.explained.localOnly ? <Badge colors={colors} label="Local only" tone="managed" /> : null}
              {s.explained.identity ? <KV colors={colors} label="Git identity" value={s.explained.identity.state} /> : null}
              <Text style={[styles.mutedSmall, { color: colors.foreground }]} selectable>{s.explained.reason}</Text>
            </View>
          ) : null}

          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Protocol</Text>
          {s.files.error ? <Text style={{ color: colors.statusWarning }} selectable>{s.files.error}</Text> : null}
          {s.files.data?.protocol.error ? <Text style={{ color: colors.statusWarning }} selectable>{s.files.data.protocol.error}</Text> : null}
          <Field colors={colors} label="Protocol text" multiline value={s.protocolText} onChangeText={s.setProtocolText} disabled={disabled || !s.files.loaded} />
          {s.protocolDraft?.conflict ? (
            <View style={[styles.confirmBox, { borderColor: colors.border }]}>
              <Text style={{ color: colors.statusWarning }}>The protocol changed since it was read. Your draft is kept.</Text>
              <Button colors={colors} label="Load latest and keep my draft" disabled={disabled} onPress={s.rebaseProtocol} />
            </View>
          ) : null}
          {protocolReview ? <ImpactBox colors={colors} review={protocolReview} scope="client" /> : null}
          <View style={[styles.chipRow, wrap]}>
            <Button colors={colors} label="Review protocol change" disabled={disabled || !s.protocolDraft} onPress={s.reviewProtocol} />
            <Button colors={colors} label="Confirm and save protocol" kind="primary" disabled={disabled || !protocolReview?.ok} onPress={s.saveProtocol} />
            <Button colors={colors} label="Discard protocol draft" disabled={disabled || !s.protocolDraft} onPress={s.discardProtocol} />
          </View>
          {s.poolImpact && s.poolImpact.client === s.selected ? <ImpactBox colors={colors} review={s.poolImpact.result} scope="client" /> : null}
        </View>
      ) : null}
      {/* Pool editors stay mounted (hidden) while no client is open or another one is, so a dirty draft survives. */}
      <View style={s.selected ? undefined : { display: "none" }}>{poolSlot}</View>

      {s.draft?.conflict ? (
        <View style={[styles.confirmBox, { borderColor: colors.border }]}>
          <Text style={{ color: colors.statusWarning }}>The map changed since it was read. Your draft is kept.</Text>
          <Button colors={colors} label="Load latest and keep my draft" disabled={disabled} onPress={s.rebase} />
        </View>
      ) : null}
      {review ? <ImpactBox colors={colors} review={review} scope="map" /> : null}
      <View style={[styles.chipRow, wrap]}>
        <Button colors={colors} label="Review map change" disabled={disabled || !s.dirty} onPress={s.reviewMap} />
        <Button colors={colors} label="Confirm and save map" kind="primary" disabled={disabled || !review?.ok} onPress={s.saveMap} />
        <Button colors={colors} label="Discard map draft" disabled={disabled || !s.dirty} onPress={s.discard} />
        <Button colors={colors} label="Reload clients" disabled={disabled} onPress={() => void s.reload()} />
      </View>
      {compact ? null : <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Every save asks the server to validate again, needs the confirmation of what you reviewed, and is recorded in the local audit log (time, file, hashes; never content).</Text>}
    </Card>
  );
}
