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
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";
import { isPendingRefund } from "../utils/orders";

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
  return (
    <View style={styles.orderCard}>
      <View style={styles.orderRow}>
        <Text style={styles.orderId}>#{order.id.slice(0, 8).toUpperCase()}</Text>
        <StatusPill status={order.status} />
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
      {isPendingRefund(order) ? <RefundActions order={order} /> : null}
      {!isPendingRefund(order) && order.status === "paid" ? (
        <FulfillAction order={order} />
      ) : null}
    </View>
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
          <ActivityIndicator size="large" color="#2d6a4f" />
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
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
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
              <ActivityIndicator size="small" color="#2d6a4f" />
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
    backgroundColor: "#f7f9f7",
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 8,
  },
  stateText: {
    fontSize: 16,
    color: "#444",
    textAlign: "center",
    fontWeight: "600",
  },
  stateSubText: {
    fontSize: 13,
    color: "#888",
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 10,
  },
  orderCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
    gap: 8,
  },
  orderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  orderId: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1a1a1a",
    fontVariant: ["tabular-nums"],
  },
  orderDate: {
    fontSize: 13,
    color: "#888",
  },
  orderTotal: {
    fontSize: 15,
    fontWeight: "700",
    color: "#2d6a4f",
  },
  retryButton: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2d6a4f",
    marginTop: 8,
  },
  retryText: {
    color: "#2d6a4f",
    fontSize: 14,
    fontWeight: "600",
  },
  footerSpinner: {
    paddingVertical: 16,
    alignItems: "center",
  },
  // Refund block
  refundBlock: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#f0f0f0",
    paddingTop: 10,
    gap: 8,
  },
  refundMarker: {
    gap: 2,
  },
  refundMarkerText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#e65100",
  },
  refundReason: {
    fontSize: 13,
    color: "#555",
  },
  refundActions: {
    flexDirection: "row",
    gap: 8,
  },
  approveButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#2d6a4f",
    alignItems: "center",
  },
  approveButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  declineButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e65100",
    alignItems: "center",
  },
  declineButtonText: {
    color: "#e65100",
    fontSize: 13,
    fontWeight: "600",
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  // Fulfill block
  fulfillBlock: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#f0f0f0",
    paddingTop: 10,
  },
  fulfillButton: {
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#2d6a4f",
    alignItems: "center",
  },
  fulfillButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
});
