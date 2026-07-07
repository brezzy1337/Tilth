/**
 * StatusPill — shared order-status badge used by OrdersScreen and StoreOrdersScreen.
 *
 * Renders a small coloured pill for a given OrderStatus.
 * Unknown/future statuses fall back to a neutral grey pill.
 *
 * When the order is `paid` and carries a `preparationState` ("packing" | "ready"),
 * the pill renders that granular sub-state instead of the plain "Paid" label —
 * preparation is orthogonal to status and moves no money (see
 * `orders.setPreparationState`). Callers that don't pass `preparationState` keep
 * the existing plain-status behaviour unchanged.
 *
 * Layout is delegated to ColorBadge; this file owns only the status→colour mapping.
 *
 * Restyled to "Garden Fresh" tokens (F-044). The status→colour SEMANTICS are
 * unchanged (same statuses read as "good"/"waiting"/"bad"/etc as before) —
 * only the underlying hex values moved onto theme tokens. The old palette had
 * six visually distinct hues (amber/green/teal/pink-red/purple/orange); the
 * token set only defines five (primary+secondary greens, accent amber, pop
 * tomato, danger red) plus neutrals, so two statuses share a token family:
 *   - `fulfilled` reuses the primary green (deeper than `paid`'s secondary
 *     green) instead of the old teal — no teal token exists.
 *   - `refunded` uses a neutral surfaceAlt/textMuted tone instead of the old
 *     purple — no purple token exists; "refunded" reads as a settled/neutral
 *     state rather than good or bad, so neutral fits semantically too.
 *   - `disputed` uses the tomato `pop` token instead of the old orange — pop
 *     is meant for "small doses only" per theme docs, which a small pill fits.
 * Flagging both gaps (no teal, no purple) in case a future palette pass wants
 * to add dedicated tokens instead of reusing these.
 */

import React from "react";
import type { OrderPreparationState, OrderStatus } from "@homegrown/shared";
import { capitalise } from "../utils/text";
import { ColorBadge } from "./ColorBadge";
import { colors } from "../theme";

// ---------------------------------------------------------------------------
// Status config — single source of truth for pill colours across the app
// ---------------------------------------------------------------------------

export const STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; bg: string; text: string }
> = {
  pending_payment: { label: "Finalizing", bg: colors.accentSoft, text: colors.text },
  // paid uses a neutral bg so only fulfilled carries the green tint —
  // primarySoft === secondarySoft in this palette, and "money in" vs "done"
  // must stay glanceable.
  paid:            { label: "Paid",       bg: colors.surfaceAlt, text: colors.secondary },
  fulfilled:       { label: "Fulfilled",  bg: colors.primarySoft, text: colors.primary },
  cancelled:       { label: "Cancelled",  bg: colors.dangerSoft, text: colors.danger },
  refunded:        { label: "Refunded",   bg: colors.surfaceAlt, text: colors.textMuted },
  disputed:        { label: "Disputed",   bg: colors.popSoft, text: colors.pop },
};

/**
 * Sub-state config for a `paid` order's operational prep progress. Kept in this
 * file alongside STATUS_CONFIG so the pill's colour mapping stays in one place.
 */
export const PREPARATION_STATE_CONFIG: Record<
  OrderPreparationState,
  { label: string; bg: string; text: string }
> = {
  packing: { label: "Packing", bg: colors.accentSoft, text: colors.text },
  ready:   { label: "Ready",   bg: colors.secondarySoft, text: colors.secondary },
};

// ---------------------------------------------------------------------------
// StatusPill component
// ---------------------------------------------------------------------------

export function StatusPill({
  status,
  preparationState,
}: {
  status: OrderStatus;
  preparationState?: OrderPreparationState | null;
}) {
  if (status === "paid" && preparationState) {
    const prepConfig = PREPARATION_STATE_CONFIG[preparationState];
    return <ColorBadge label={prepConfig.label} bg={prepConfig.bg} text={prepConfig.text} />;
  }

  const config =
    STATUS_CONFIG[status] ?? { label: capitalise(status), bg: colors.surfaceAlt, text: colors.textMuted };
  return <ColorBadge label={config.label} bg={config.bg} text={config.text} />;
}
