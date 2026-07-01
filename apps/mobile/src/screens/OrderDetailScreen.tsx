/**
 * OrderDetailScreen — single order view.
 *
 * Reads route.params.orderId; fetches trpc.orders.get({ id: orderId }).
 * Shows:
 *   - Status banner (paid = green, pending_payment = amber "Finalizing")
 *   - Line items: nameSnapshot, qty × unitPriceCents = lineTotalCents
 *   - Subtotal
 *   - Platform fee (applicationFeeCents, labelled "Platform fee")
 *   - Total
 *
 * If status is pending_payment, refetchInterval polls every 3 s so a lagging
 * webhook flips the display to "paid" without manual refresh.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { OrderStatus } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { ColorBadge } from "../components/ColorBadge";
import { PREPARATION_STATE_CONFIG } from "../components/StatusPill";
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";
import { capitalise } from "../utils/text";

type Props = NativeStackScreenProps<AuthedStackParamList, "OrderDetail">;

// ---------------------------------------------------------------------------
// Status banner
// ---------------------------------------------------------------------------

const STATUS_BANNER: Record<OrderStatus, { label: string; bg: string; text: string }> = {
  pending_payment: { label: "Finalizing payment…",  bg: "#fff8e1", text: "#92400e" },
  paid:            { label: "Payment confirmed",     bg: "#e8f5e9", text: "#2d6a4f" },
  fulfilled:       { label: "Order fulfilled",       bg: "#e0f2f1", text: "#00695c" },
  cancelled:       { label: "Order cancelled",       bg: "#fce4ec", text: "#b71c1c" },
  refunded:        { label: "Order refunded",        bg: "#f3e5f5", text: "#6a1b9a" },
  disputed:        { label: "Payment disputed",      bg: "#fff3e0", text: "#e65100" },
};

function StatusBanner({ status }: { status: OrderStatus }) {
  const config =
    STATUS_BANNER[status] ?? {
      label: capitalise(status),
      bg: "#e5e7eb",
      text: "#374151",
    };
  return (
    <View style={[styles.banner, { backgroundColor: config.bg }]}>
      <Text style={[styles.bannerText, { color: config.text }]}>{config.label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// OrderDetailScreen
// ---------------------------------------------------------------------------

export function OrderDetailScreen({ route }: Props) {
  const { orderId } = route.params;
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const { data: order, isLoading, error, refetch } = trpc.orders.get.useQuery(
    { id: orderId },
    {
      // Poll every 3 s while the order is still awaiting webhook confirmation
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "pending_payment" ? 3000 : false;
      },
    },
  );

  const requestRefund = trpc.orders.requestRefund.useMutation({
    onSuccess: () => {
      void utils.orders.get.invalidate({ id: orderId });
    },
    onError: (err) => {
      Alert.alert("Error", err.message ?? "Could not submit refund request. Please try again.");
    },
  });

  function handleRequestRefund() {
    Alert.alert(
      "Request a refund",
      "Request a refund for this order?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Request refund",
          style: "destructive",
          onPress: () => {
            requestRefund.mutate({ orderId });
          },
        },
      ],
    );
  }

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color="#2d6a4f" />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !order) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load order.</Text>
          {error ? <Text style={styles.stateSubText}>{error.message}</Text> : null}
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Status banner */}
        <StatusBanner status={order.status} />

        {/* Order ID */}
        <Text style={styles.orderId}>Order #{order.id.slice(0, 8).toUpperCase()}</Text>
        <Text style={styles.orderDate}>
          {new Date(order.createdAt).toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </Text>

        {/* Fulfillment */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Fulfillment</Text>
          {order.fulfillmentMethod === "delivery" ? (
            <View style={styles.fulfillmentRow}>
              <Text style={styles.fulfillmentLabel}>Delivery</Text>
              {order.deliveryAddress ? (
                <Text style={styles.fulfillmentAddress}>{order.deliveryAddress}</Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.fulfillmentLabel}>Pickup at seller&apos;s stand</Text>
          )}
        </View>

        {/* Preparation — read-only; the seller advances this from StoreOrdersScreen.
            Moves no money and is orthogonal to `status`, so it's only meaningful
            while the order sits at `paid`. */}
        {order.status === "paid" && order.preparationState ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Preparation</Text>
            <ColorBadge
              label={PREPARATION_STATE_CONFIG[order.preparationState].label}
              bg={PREPARATION_STATE_CONFIG[order.preparationState].bg}
              text={PREPARATION_STATE_CONFIG[order.preparationState].text}
            />
          </View>
        ) : null}

        {/* Line items */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Items</Text>
          <FlatList
            data={order.items}
            keyExtractor={(i) => i.id}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <View style={styles.lineCard}>
                <Text style={styles.lineName}>{item.nameSnapshot}</Text>
                <View style={styles.lineRow}>
                  <Text style={styles.lineDetail}>
                    {item.quantity} × ${formatCents(item.unitPriceCents)}
                  </Text>
                  <Text style={styles.lineTotal}>${formatCents(item.lineTotalCents)}</Text>
                </View>
              </View>
            )}
          />
        </View>

        {/* Summary */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>${formatCents(order.subtotalCents)}</Text>
          </View>
          {order.tipCents > 0 ? (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Tip</Text>
              <Text style={styles.summaryValue}>${formatCents(order.tipCents)}</Text>
            </View>
          ) : null}
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Platform fee</Text>
            <Text style={styles.summaryValue}>${formatCents(order.applicationFeeCents)}</Text>
          </View>
          <View style={[styles.summaryRow, styles.summaryTotalRow]}>
            <Text style={styles.summaryTotalLabel}>Total</Text>
            <Text style={styles.summaryTotalValue}>${formatCents(order.totalCents)}</Text>
          </View>
        </View>

        {/* Refund section — buyer only */}
        {user && order.buyerId === user.id && (
          <>
            {order.refundApprovedAt ? (
              <View style={styles.refundBadgeWrapper}>
                <ColorBadge label="Refund approved" bg="#fff3e0" text="#2d6a4f" />
              </View>
            ) : order.refundRequestedAt ? (
              <View style={styles.refundBadgeWrapper}>
                <ColorBadge label="Refund requested" bg="#fff3e0" text="#e65100" />
              </View>
            ) : (
              <>
                {order.refundDeclinedAt ? (
                  <View style={styles.refundBadgeWrapper}>
                    <ColorBadge label="Refund declined" bg="#fff8e1" text="#92400e" />
                  </View>
                ) : null}
                {(order.status === "paid" || order.status === "fulfilled") ? (
                  <Pressable
                    style={({ pressed }) => [
                      styles.refundButton,
                      pressed && styles.refundButtonPressed,
                      requestRefund.isPending && styles.refundButtonDisabled,
                    ]}
                    onPress={handleRequestRefund}
                    disabled={requestRefund.isPending}
                  >
                    <Text style={styles.refundButtonText}>
                      {requestRefund.isPending ? "Requesting…" : "Request refund"}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </>
        )}
      </ScrollView>
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
  container: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 48,
    gap: 0,
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
  banner: {
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
    alignItems: "center",
  },
  bannerText: {
    fontSize: 16,
    fontWeight: "700",
  },
  orderId: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a1a1a",
    marginBottom: 4,
  },
  orderDate: {
    fontSize: 13,
    color: "#888",
    marginBottom: 24,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#2d6a4f",
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  lineCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 1,
  },
  lineName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1a1a1a",
    marginBottom: 6,
  },
  lineRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  lineDetail: {
    fontSize: 13,
    color: "#666",
  },
  lineTotal: {
    fontSize: 14,
    fontWeight: "700",
    color: "#2d6a4f",
  },
  summaryCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 1,
    gap: 10,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  summaryLabel: {
    fontSize: 14,
    color: "#666",
  },
  summaryValue: {
    fontSize: 14,
    color: "#1a1a1a",
    fontWeight: "500",
  },
  summaryTotalRow: {
    borderTopWidth: 1,
    borderTopColor: "#e8eae8",
    paddingTop: 10,
  },
  summaryTotalLabel: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  summaryTotalValue: {
    fontSize: 18,
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
  // Refund affordance
  refundButton: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e65100",
    alignItems: "center",
  },
  refundButtonPressed: {
    backgroundColor: "#fff3e0",
  },
  refundButtonDisabled: {
    opacity: 0.5,
  },
  refundButtonText: {
    color: "#e65100",
    fontSize: 15,
    fontWeight: "600",
  },
  refundBadgeWrapper: {
    marginTop: 16,
    alignItems: "flex-start",
  },
  fulfillmentRow: {
    gap: 4,
  },
  fulfillmentLabel: {
    fontSize: 14,
    color: "#1a1a1a",
    fontWeight: "500",
  },
  fulfillmentAddress: {
    fontSize: 13,
    color: "#666",
  },
});
