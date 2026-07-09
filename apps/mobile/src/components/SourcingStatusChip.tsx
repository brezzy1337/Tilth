/**
 * SourcingStatusChip — lifecycle-status badge for a sourcing request/offer
 * (F-049). Shared by SourcingScreen's "My requests" rows and
 * ConversationScreen's request card so the pending/accepted/declined/
 * withdrawn -> color mapping lives in exactly one place.
 *
 * Colors are pulled from theme tokens (no invented hexes), reusing the same
 * semantics StatusPill established for order statuses: sunflower amber for
 * "waiting", green for "good", tomato for "declined/bad", neutral for
 * "settled, no further action" (withdrawn).
 *
 * Layout delegated to ColorBadge, same as StatusPill.
 */

import React from "react";
import type { SourcingRequestStatus } from "@homegrown/shared";
import { colors } from "../theme";
import { ColorBadge } from "./ColorBadge";

const SOURCING_STATUS_CONFIG: Record<
  SourcingRequestStatus,
  { label: string; bg: string; text: string }
> = {
  pending: { label: "Pending", bg: colors.accentSoft, text: colors.text },
  accepted: { label: "Accepted", bg: colors.primarySoft, text: colors.primary },
  declined: { label: "Declined", bg: colors.popSoft, text: colors.pop },
  withdrawn: { label: "Withdrawn", bg: colors.surfaceAlt, text: colors.textMuted },
};

export function SourcingStatusChip({ status }: { status: SourcingRequestStatus }) {
  const config = SOURCING_STATUS_CONFIG[status];
  return <ColorBadge label={config.label} bg={config.bg} text={config.text} />;
}
