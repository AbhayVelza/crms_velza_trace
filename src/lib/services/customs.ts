// Customs (since 16 Nov 2026): the partner type WAREHOUSE (IDs VW…) is Customs, where a Velza person receives the
// plant's containers and clears them. How goods are scanned in there is not fixed yet, so each receiving method is
// a setting (Settings.customsReceiveModes):
//   CONTAINER — scan the container number: every lot of it still on its way is received (containers.ts)
//   LOT       — scan a case or tray code: that lot is received (movement.ts)
// Pallets later: add "PALLET" to CUSTOMS_RECEIVE_MODES and a pallet → lots resolver next to the two above.
// Holding (AT_CUSTOMS), clearing (per container) and dispatch work on lots and need no change.

import { CUSTOMS_RECEIVE_MODES, DEFAULT_SETTINGS, type Container, type CustomsReceiveMode, type Settings } from "@/lib/core/types";
import type { StoreTx } from "@/lib/store";

/** Is this receiving method switched on for Customs? */
export function receiveModeAllowed(settings: Pick<Settings, "customsReceiveModes">, mode: CustomsReceiveMode): boolean {
  const modes = settings.customsReceiveModes ?? DEFAULT_SETTINGS.customsReceiveModes ?? [...CUSTOMS_RECEIVE_MODES];
  return modes.includes(mode);
}

/** What the person scanning is told when a method is switched off. */
export const RECEIVE_MODE_OFF_MESSAGE: Record<CustomsReceiveMode, string> = {
  CONTAINER: "Customs receives case by case — scan each case or tray",
  LOT: "Customs receives whole containers — scan the container number",
};

/** The container (on its way to, received at, or cleared at this Customs) that carried this lot; null if none. */
export async function containerOfLot(tx: StoreTx, receiverId: string, lotCode: string): Promise<Container | null> {
  // One indexed lookup (GIN on lot_codes, schema v9), not every container ever sent to this Customs.
  return tx.latestContainerWithLot(receiverId, lotCode, ["IN_TRANSIT", "RECEIVED", "CLEARED"]);
}
