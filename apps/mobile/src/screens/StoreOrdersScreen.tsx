/**
 * StoreOrdersScreen — seller view of all orders for their store.
 *
 * Fetches trpc.orders.listForMyStore (newest first) with infinite-scroll keyset
 * pagination. Pull-to-refresh surfaces webhook-driven status changes (e.g. a
 * refund that completed server-side). No interval polling.
 *
 * FlatList: short order id, total, status pill.
 * For orders with a pending refund request (refundRequestedAt set,
 * refundApprovedAt/refundDeclinedAt null): shows "Refund requested" marker
 * + reason, and two action buttons — Approve and Decline (each with a confirm
 * Alert, disabled while mutation isPending, invalidates cache on success).
 *
 * States: loading, error (retry), empty ("No orders yet"), list.
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Order } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { StatusPill } from "../components/StatusPill";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";
import { isPendingRefund } from "../utils/orders";
import { colors, radii, spacing, type } from "../theme";

type Props = NativeStackScreenProps<AuthedStackParamList, "StoreOrders">;

// ---------------------------------------------------------------------------
// RefundActions — approve / decline buttons for a single order row
// ---------------------------------------------------------------------------

function RefundActions({ order }: { order: Order }) {
  const utils = trpc.useUtils();

  const approveRefund = trpc.orders.approveRefund.useMutation({
    onSuccess: () => {
      void utils.orders.listForMyStore.invalidate();
    },
    onError: (err) => {
      Alert.alert("Error", err.message ?? "Could not approve refund. Please try again.");
    },
  });

  const declineRefund = trpc.orders.declineRefund.useMutation({
    onSuccess: () => {
      void utils.orders.listForMyStore.invalidate();
    },
    onError: (err) => {
      Alert.alert("Error", err.message ?? "Could not decline refund. Please try again.");
    },
  });

  function handleApprove() {
    Alert.alert(
      "Approve refund",
      `Approve the refund for order #${order.id.slice(0, 8).toUpperCase()}? This will issue a full refund to the buyer via Stripe.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve",
          onPress: () => {
            approveRefund.mutate({ orderId: order.id });
          },
        },
      ],
    );
  }

  function handleDecline() {
    Alert.alert(
      "Decline refund",
      `Decline the refund request for order #${order.id.slice(0, 8).toUpperCase()}? The buyer will be able to re-request.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Decline",
          style: "destructive",
          onPress: () => {
            declineRefund.mutate({ orderId: order.id });
          },
        },
      ],
    );
  }

  const anyPending = approveRefund.isPending || declineRefund.isPending;

  return (
    <View style={styles.refundBlock}>
      <View style={styles.refundMarker}>
        <Text style={styles.refundMarkerText}>Refund requested</Text>
        {order.refundReason ? (
          <Text style={styles.refundReason}>{order.refundReason}</Text>
        ) : null}
      </View>
      <View style={styles.refundActions}>
        <Pressable
          style={[
            styles.approveButton,
            anyPending && styles.actionButtonDisabled,
          ]}
          onPress={handleApprove}
          disabled={anyPending}
        >
          <Text style={styles.approveButtonText}>
            {approveRefund.isPending ? "Approving…" : "Approve refund"}
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.declineButton,
            anyPending && styles.actionButtonDisabled,
          ]}
          onPress={handleDecline}
          disabled={anyPending}
        >
          <Text style={styles.declineButtonText}>
            {declineRefund.isPending ? "Declining…" : "Decline"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// PreparationAction — "Start packing" / "Mark ready" button that advances a
// paid order's operational preparationState (null → packing → ready). Moves
// no money; orthogonal to the "Mark fulfilled" capture action below.
// ---------------------------------------------------------------------------

function PreparationAction({ order }: { order: Order }) {
  const utils = trpc.useUtils();

  const setPreparationState = trpc.orders.setPreparationState.useMutation({
    onSuccess: () => {
      void utils.orders.listForMyStore.invalidate();
    },
    onError: (err) => {
      Alert.alert("Error", err.message ?? "Could not update order. Please try again.");
    },
  });

  if (order.preparationState === "ready") {
    return null;
  }

  const nextState = order.preparationState === "packing" ? "ready" : "packing";
  const label = nextState === "packing" ? "Start packing" : "Mark ready";

  function handleAdvance() {
    setPreparationState.mutate({ orderId: order.id, state: nextState });
  }

  return (
    <View style={styles.prepBlock}>
      <Pressable
        style={[styles.prepButton, setPreparationState.isPending && styles.actionButtonDisabled]}
        onPress={handleAdvance}
        disabled={setPreparationState.isPending}
      >
        <Text style={styles.prepButtonText}>
          {setPreparationState.isPending ? "Saving…" : label}
        </Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// FulfillAction — "Mark fulfilled" button for a paid, non-refund-pending order
// ---------------------------------------------------------------------------

function FulfillAction({ order }: { order: Order }) {
  const utils = trpc.useUtils();

  const markFulfilled = trpc.orders.markFulfilled.useMutation({
    onSuccess: () => {
      void utils.orders.listForMyStore.invalidate();
    },
    onError: (err) => {
      Alert.alert("Error", err.message ?? "Could not mark order as fulfilled. Please try again.");
    },
  });

  function handleFulfill() {
    Alert.alert(
      "Mark as fulfilled",
      `Mark order #${order.id.slice(0, 8).toUpperCase()} as fulfilled?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Mark fulfilled",
          onPress: () => {
            markFulfilled.mutate({ orderId: order.id });
          },
        },
      ],
    );
  }

  return (
    <View style={styles.fulfillBlock}>
      <Pressable
        style={[styles.fulfillButton, markFulfilled.isPending && styles.actionButtonDisabled]}
        onPress={handleFulfill}
        disabled={markFulfilled.isPending}
      >
        <Text style={styles.fulfillButtonText}>
          {markFulfilled.isPending ? "Marking…" : "Mark fulfilled"}
        </Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// OrderRow
// ---------------------------------------------------------------------------

function OrderRow({ order }: { order: Order }) {
  const fulfillmentLine =
    order.fulfillmentMethod === "delivery"
      ? `Delivery${order.deliveryAddress ? ` — ${order.deliveryAddress}` : ""}`
      : "Pickup";

  return (
    <Card style={styles.orderCard}>
      <View style={styles.orderRow}>
        <Text style={styles.orderId}>#{order.id.slice(0, 8).toUpperCase()}</Text>
        <StatusPill status={order.status} preparationState={order.preparationState} />
      </View>
      <View style={styles.orderRow}>
        <Text style={styles.orderDate}>
          {new Date(order.createdAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </Text>
        <Text style={styles.orderTotal}>${formatCents(order.totalCents)}</Text>
      </View>
      <Text style={styles.fulfillmentLine}>{fulfillmentLine}</Text>
      {isPendingRefund(order) ? <RefundActions order={order} /> : null}
      {!isPendingRefund(order) && order.status === "paid" ? (
        <>
          <PreparationAction order={order} />
          <FulfillAction order={order} />
        </>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// StoreOrdersScreen
// ---------------------------------------------------------------------------

export function StoreOrdersScreen(_props: Props) {
  const {
    data,
    isLoading,
    error,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.orders.listForMyStore.useInfiniteQuery(
    { limit: 20 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );

  const orders = data?.pages.flatMap((p) => p.orders) ?? [];

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load orders.</Text>
          <Text style={styles.stateSubText}>{error.message}</Text>
          <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetch()} />
        </View>
      </SafeAreaView>
    );
  }

  if (orders.length === 0) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>No orders yet.</Text>
          <Text style={styles.stateSubText}>Orders from buyers will appear here.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <OrderRow order={item} />}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
          />
        }
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.footerSpinner}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    gap: spacing.sm,
  },
  stateText: {
    fontSize: type.body.fontSize + 1,
    color: colors.text,
    textAlign: "center",
    fontWeight: "600",
  },
  stateSubText: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl,
    gap: spacing.sm + 2,
  },
  orderCard: {
    gap: spacing.sm,
  },
  orderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  orderId: {
    fontSize: type.caption.fontSize + 1,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  orderDate: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
  orderTotal: {
    fontSize: type.body.fontSize,
    fontWeight: "700",
    color: colors.primary,
  },
  footerSpinner: {
    paddingVertical: spacing.lg,
    alignItems: "center",
  },
  fulfillmentLine: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    fontWeight: "500",
  },
  // Refund block
  refundBlock: {
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm + 2,
    gap: spacing.sm,
  },
  refundMarker: {
    gap: 2,
  },
  refundMarkerText: {
    fontSize: type.caption.fontSize,
    fontWeight: "700",
    color: colors.pop,
  },
  refundReason: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
  refundActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  approveButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  approveButtonText: {
    color: colors.onPrimary,
    fontSize: type.caption.fontSize,
    fontWeight: "600",
  },
  declineButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.pop,
    alignItems: "center",
  },
  declineButtonText: {
    color: colors.pop,
    fontSize: type.caption.fontSize,
    fontWeight: "600",
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  // Preparation block
  prepBlock: {
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm + 2,
  },
  prepButton: {
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: "center",
  },
  prepButtonText: {
    color: colors.text,
    fontSize: type.caption.fontSize,
    fontWeight: "600",
  },
  // Fulfill block
  fulfillBlock: {
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm + 2,
  },
  fulfillButton: {
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  fulfillButtonText: {
    color: colors.onPrimary,
    fontSize: type.caption.fontSize,
    fontWeight: "600",
  },
});
