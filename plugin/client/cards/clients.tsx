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
  ClientsMapDraftValue,
  ExplainResolutionResult,
  GetClientFilesResult,
  GetClientsResult,
  GetPeerPoolRequest,
  GetPeerPoolResult,
  IdentifyRepositoryResult,
  PeerPoolValue,
  SetPeerPoolRequest,
  SetPeerPoolResult,
  TargetValue,
  ValidateClientsDraftResult,
} from "../../shared/contracts.ts";
import { errorMessage } from "../manager-state.ts";
import { useTargetSnapshot } from "../target-async.ts";
import { Badge, Button, Card, Field, KV, styles } from "../ui-kit.tsx";
import type { Colors } from "../ui-kit.tsx";

export type ClientsApi = {
  getClients(input: { schemaVersion: 1; target: TargetValue }): Promise<GetClientsResult>;
  getClientFiles(input: { schemaVersion: 1; target: TargetValue; client: string }): Promise<GetClientFilesResult>;
  validate(input: { schemaVersion: 1; target: TargetValue; draft:
    | { kind: "map"; map: ClientsMapDraftValue }
    | { kind: "pool"; client: string; pool: PeerPoolValue }
    | { kind: "protocol"; client: string; text: string } }): Promise<ValidateClientsDraftResult>;
  identify(input: { schemaVersion: 1; target: TargetValue; path: string }): Promise<IdentifyRepositoryResult>;
  explain(input: { schemaVersion: 1; target: TargetValue; path: string }): Promise<ExplainResolutionResult>;
  setClients(input: { schemaVersion: 1; target: TargetValue; map: ClientsMapDraftValue; expectedSha256: string | null; confirm: string }): Promise<{ sha256: string }>;
  setClientPool(input: { schemaVersion: 1; target: TargetValue; client: string; pool: PeerPoolValue; expectedSha256: string | null; confirm: string }): Promise<{ sha256: string }>;
  setClientProtocol(input: { schemaVersion: 1; target: TargetValue; client: string; text: string; expectedSha256: string | null; confirm: string }): Promise<{ sha256: string }>;
  /** Workspaces the connected Paseo host knows (id, name, directory). */
  listWorkspaces(): Promise<{ id: string; name: string; directory: string }[]>;
};

export const emptyClientsMap = (): ClientsMapDraftValue => ({ version: 1, protectedRoots: [], clients: {}, repositories: [] });
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
    if (saved) { mapDrafts.current.delete(targetKey); setNotice("Map saved. The new map hash applies to the next seat formation."); await snapshot.reload(target); touch(); }
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

  // ---- repositories: identity is computed by the server -----------------
  const [candidate, setCandidate] = useState<(IdentifyRepositoryResult & { path: string }) | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; directory: string }[] | null>(null);
  const [project, setProject] = useState("");
  const identify = async (path: string) => {
    if (!target || !path.trim()) return;
    const found = await run(() => api.identify({ schemaVersion: 1, target, path: path.trim() }));
    if (found) { setCandidate({ ...found, path: path.trim() }); setProject(found.projectSuggestion); setNotice(null); }
  };
  const loadWorkspaces = async () => { const list = await run(() => api.listWorkspaces()); if (list) setWorkspaces(list); };
  const addCandidate = () => {
    if (!candidate || !selected || candidate.mappedClient !== null || !project.trim()) return;
    edit(next => { next.repositories.push({ client: selected, project: project.trim(), gitCommonDir: candidate.gitCommonDir, originSha256: candidate.originSha256 }); });
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
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Repositories</Text>
          {s.map.repositories.map((entry, index) => entry.client !== s.selected ? null : (
            <View key={`${entry.gitCommonDir}`} style={styles.field}>
              <Field colors={colors} label="Project" value={entry.project} onChangeText={text => s.renameProject(index, text)} disabled={disabled} />
              <KV colors={colors} label="Git common dir" value={entry.gitCommonDir} />
              <KV colors={colors} label="Origin hash" value={`${entry.originSha256.slice(0, 16)}…`} />
              <Button colors={colors} label="Remove repository" kind="danger" disabled={disabled} onPress={() => s.removeRepository(index)} />
            </View>
          ))}
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Add a repository</Text>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>The server reads the common dir and the origin hash from Git; you never type them.</Text>
          <Button colors={colors} label="Load Paseo workspaces" disabled={disabled} onPress={s.loadWorkspaces} />
          {(s.workspaces ?? []).map(workspace => (
            <View key={workspace.id} style={[styles.chipRow, wrap]}>
              <Text style={[styles.mutedSmall, { color: colors.foreground }]} selectable>{workspace.name}</Text>
              <Button colors={colors} label="Use this workspace" disabled={disabled} onPress={() => { setPath(workspace.directory); void s.identify(workspace.directory); }} />
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
              <KV colors={colors} label="Origin hash" value={`${s.candidate.originSha256.slice(0, 16)}…`} />
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
