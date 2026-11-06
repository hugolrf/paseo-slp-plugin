// One Peer pool editor per opened client. Each session owns its own hook state
// (draft, dirty flag, snapshot) under the key `<target>|client:<client>` and
// stays mounted but hidden while another client is open, so a dirty pool draft
// is never shown to, or saved through, another client and is still there when
// the Human comes back. Sessions are keyed by target + client by the shell.
import { useRef } from "react";
import { View } from "react-native";
import type { FamilyName, StatusResult, TargetValue } from "../../shared/contracts.ts";
import type { useCatalogCache } from "../catalog-demand.ts";
import { useCatalogDemand } from "../catalog-demand.ts";
import type { JevCardState } from "./jev.tsx";
import { PeerPoolCard, usePeerPoolCard } from "./peer-pool.tsx";
import type { Colors } from "../ui-kit.tsx";

export function ClientPoolSession({ colors, compact, active, client, target, targetKey, adapters, cache, statusView, jev, availableFamilies, scrollFocusNode, update }: {
  colors: Colors;
  compact: boolean;
  active: boolean;
  client: string;
  target: TargetValue;
  targetKey: string;
  adapters: { get: Parameters<typeof usePeerPoolCard>[0]["callGetPeerPool"]; set: Parameters<typeof usePeerPoolCard>[0]["callSetPeerPool"] };
  cache: ReturnType<typeof useCatalogCache>;
  statusView: StatusResult | null;
  jev: JevCardState;
  availableFamilies: readonly FamilyName[];
  scrollFocusNode: (node: unknown, focus?: boolean) => void;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  const ownKey = `${targetKey}|client:${client}`;
  const ownKeyRef = useRef(ownKey);
  ownKeyRef.current = ownKey;
  const pool = usePeerPoolCard({
    target,
    targetKey: ownKey,
    isCurrentKey: candidate => candidate === ownKeyRef.current,
    callGetPeerPool: adapters.get,
    callSetPeerPool: adapters.set,
    catalogs: cache.catalogs,
    featureSets: cache.featureSets,
    featuresLoadingFor: cache.featuresLoadingFor,
    catalogIsRefreshing: cache.catalogIsRefreshing,
    featureIsRefreshing: cache.featureIsRefreshing,
    scrollFocusNode,
    update,
  });
  useCatalogDemand(cache, pool.poolForm.seats.map(seat => ({ family: seat.family, role: "peer" as const })), pool.featureKeys);
  return (
    <View style={active ? undefined : { display: "none" }}>
      <PeerPoolCard
        colors={colors}
        target={target}
        compact={compact}
        statusView={statusView}
        jev={jev}
        pool={pool}
        availableFamilies={availableFamilies}
        catalogs={cache.catalogs}
        catalogLoadingFor={cache.catalogLoadingFor}
        retryCatalog={cache.retryCatalog}
        retryFeatureSet={cache.retryFeatureSet}
        scrollFocusNode={scrollFocusNode}
        heading={{ title: "Client Peer pool", subtitle: "Peer seats of this client only. Seats formed for the client's repositories read this pool, never the user pool or another client." }}
      />
    </View>
  );
}
