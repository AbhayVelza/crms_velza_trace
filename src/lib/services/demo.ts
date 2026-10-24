// Dev-only demo helper: click-to-scan codes relevant to each screen, so the demo runs without a scanner.

import { NEXT_TIER } from "@/lib/core/rules";
import type { Lot, Pack } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { isVisible, loadActor, partnerName } from "./common";

export const DEMO_SCREENS = ["verify", "dispatch", "receive", "open", "reprint", "void", "search"] as const;
export type DemoScreen = (typeof DEMO_SCREENS)[number];

export interface DemoCode {
  code: string;
  label: string;
}

const FAKE: DemoCode = { code: "91ZZZZZZOR00001", label: "made-up code" };

export async function demoCodes(userId: string | null, screen: DemoScreen, lotCode?: string): Promise<DemoCode[]> {
  const store = getStore();
  const actor = await loadActor(store, userId);
  const me = actor.partner?.id ?? null;
  const [allLots, allPacks, partners] = await Promise.all([store.lots.list(), store.packs.list(), store.partners.list()]);
  const lots = allLots.filter((l) => isVisible(l, me)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.lotNumber - b.lotNumber);
  const lotByCode = new Map(lots.map((l) => [l.lotCode, l]));
  const packs = allPacks.filter((p) => lotByCode.has(p.lotCode)).sort((a, b) => a.packCode.localeCompare(b.packCode));
  const loose = (p: Pack) => lotByCode.get(p.lotCode)?.status === "OPENED";
  const name = (id: string | null) => {
    const p = partners.find((x) => x.id === id);
    if (!p) return partnerName(partners, id) ?? "?";
    return p.type === "MANUFACTURER" ? "Manufacturer" : (p.name.match(/^([A-Za-z]+-\d+)/)?.[1] ?? p.name);
  };
  const lotLabel = (l: Lot, extra = "") => `${l.lotType.toLowerCase()} ${l.status}${l.synced ? "" : " (unsynced)"}${extra}`;

  switch (screen) {
    case "verify": {
      if (lotCode) {
        const lot = lotByCode.get(lotCode);
        const own = packs.filter((p) => p.lotCode === lotCode).map((p) => ({ code: p.packCode, label: `pack ${p.seq}` }));
        const other = packs.find((p) => p.lotCode !== lotCode && lot && lotByCode.get(p.lotCode)?.manufacturerId === lot.manufacturerId);
        return [...own, ...(other ? [{ code: other.packCode, label: "pack of another lot" }] : [])];
      }
      return lots.filter((l) => l.manufacturerId === me && (l.status === "PRINTED" || l.status === "GENERATED")).map((l) => ({ code: l.lotCode, label: lotLabel(l) }));
    }
    case "dispatch": {
      const sender = actor.partner;
      if (!sender || !NEXT_TIER[sender.type]) return [];
      const myLots = lots.filter((l) => l.locationId === me && l.status !== "IN_TRANSIT" && l.status !== "VOID" && l.status !== "GENERATED");
      const myPacks = packs.filter((p) => loose(p) && p.locationId === me && p.status !== "IN_TRANSIT");
      return [...myLots.map((l) => ({ code: l.lotCode, label: lotLabel(l) })), ...myPacks.map((p) => ({ code: p.packCode, label: `loose pack ${p.status}` }))];
    }
    case "receive": {
      const forMe = lots.filter((l) => l.status === "IN_TRANSIT" && l.inTransitToId === me).map((l) => ({ code: l.lotCode, label: `${l.lotType.toLowerCase()} from ${name(l.locationId)}` }));
      const packsForMe = packs.filter((p) => loose(p) && p.status === "IN_TRANSIT" && p.inTransitToId === me).map((p) => ({ code: p.packCode, label: `pack from ${name(p.locationId)}` }));
      const forOthers = lots.filter((l) => l.status === "IN_TRANSIT" && l.inTransitToId !== me).slice(0, 3).map((l) => ({ code: l.lotCode, label: `in transit to ${name(l.inTransitToId)}` }));
      return [...forMe, ...packsForMe, ...forOthers, FAKE];
    }
    case "open":
      return lots.filter((l) => l.locationId === me && (l.status === "AT_SUPPLIER" || l.status === "AT_OUTLET")).map((l) => ({ code: l.lotCode, label: lotLabel(l) }));
    case "reprint":
      return lots
        .filter((l) => l.manufacturerId === me && ["GENERATED", "PRINTED", "PACKED", "QUARANTINED"].includes(l.status))
        .slice(0, 6)
        .flatMap((l) => [{ code: l.lotCode, label: lotLabel(l) }, ...packs.filter((p) => p.lotCode === l.lotCode).slice(0, 1).map((p) => ({ code: p.packCode, label: "pack" }))]);
    case "void":
      return lots.filter((l) => l.manufacturerId === me && ["GENERATED", "PRINTED", "QUARANTINED"].includes(l.status)).map((l) => ({ code: l.lotCode, label: lotLabel(l) }));
    case "search": {
      const recent = lots.filter((l) => l.synced).slice(-8);
      const moved = packs.filter((p) => loose(p)).slice(0, 3);
      return [...recent.map((l) => ({ code: l.lotCode, label: lotLabel(l) })), ...moved.map((p) => ({ code: p.packCode, label: `pack ${p.status}` })), FAKE];
    }
  }
}
