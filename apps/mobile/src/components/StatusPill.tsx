/**
 * StatusPill — shared order-status badge used by OrdersScreen and StoreOrdersScreen.
 *
 * Renders a small coloured pill for a given OrderStatus.
 * Unknown/future statuses fall back to a neutral grey pill.
 *
 * Layout is delegated to ColorBadge; this file owns only the status→colour mapping.
 */

import React from "react";
import type { OrderStatus } from "@homegrown/shared";
import { capitalise } from "../utils/text";
import { ColorBadge } from "./ColorBadge";

// ---------------------------------------------------------------------------
// Status config — single source of truth for pill colours across the app
// ---------------------------------------------------------------------------

export const STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; bg: string; text: string }
> = {
  pending_payment: { label: "Finalizing", bg: "#fff8e1", text: "#92400e" },
  paid:            { label: "Paid",       bg: "#e8f5e9", text: "#2d6a4f" },
  fulfilled:       { label: "Fulfilled",  bg: "#e0f2f1", text: "#00695c" },
  cancelled:       { label: "Cancelled",  bg: "#fce4ec", text: "#b71c1c" },
  refunded:        { label: "Refunded",   bg: "#f3e5f5", text: "#6a1b9a" },
  disputed:        { label: "Disputed",   bg: "#fff3e0", text: "#e65100" },
};

// ---------------------------------------------------------------------------
// StatusPill component
// ---------------------------------------------------------------------------

export function StatusPill({ status }: { status: OrderStatus }) {
  const config =
    STATUS_CONFIG[status] ?? { label: capitalise(status), bg: "#e5e7eb", text: "#374151" };
  return <ColorBadge label={config.label} bg={config.bg} text={config.text} />;
}
