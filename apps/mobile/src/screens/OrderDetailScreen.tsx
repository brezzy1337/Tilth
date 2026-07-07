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
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";
import { capitalise } from "../utils/text";
import { colors, radii, spacing, type } from "../theme";

type Props = NativeStackScreenProps<AuthedStackParamList, "OrderDetail">;

// ---------------------------------------------------------------------------
// Status banner — local mapping (distinct from StatusPill's STATUS_CONFIG),
// retoned to the warm palette.
// ---------------------------------------------------------------------------

const STATUS_BANNER: Record<OrderStatus, { label: string; bg: string; text: string }> = {
  // Color pairs mirror StatusPill's STATUS_CONFIG so the list pill and the
  // detail banner always agree: paid = green-on-neutral (only fulfilled gets
  // the green tint), refunded = neutral "settled", disputed = tomato pop
  // (distinct from cancelled's danger red — they need different handling).
  pending_payment: { label: "Finalizing payment…", bg: colors.accentSoft,  text: colors.text },
  paid:            { label: "Payment confirmed",    bg: colors.surfaceAlt,  text: colors.secondary },
  fulfilled:       { label: "Order fulfilled",      bg: colors.primarySoft,  text: colors.primary },
  cancelled:       { label: "Order cancelled",      bg: colors.dangerSoft,   text: colors.danger },
  refunded:        { label: "Order refunded",       bg: colors.surfaceAlt,   text: colors.textMuted },
  disputed:        { label: "Payment disputed",     bg: colors.popSoft,      text: colors.pop },
};

function StatusBanner({ status }: { status: OrderStatus }) {
  const config =
    STATUS_BANNER[status] ?? {
      label: capitalise(status),
      bg: colors.surfaceAlt,
      text: colors.textMuted,
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
          <ActivityIndicator size="large" color={colors.primary} />
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
          <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetch()} />
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
              <Card style={styles.lineCard}>
                <Text style={styles.lineName}>{item.nameSnapshot}</Text>
                <View style={styles.lineRow}>
                  <Text style={styles.lineDetail}>
                    {item.quantity} × ${formatCents(item.unitPriceCents)}
                  </Text>
                  <Text style={styles.lineTotal}>${formatCents(item.lineTotalCents)}</Text>
                </View>
              </Card>
            )}
          />
        </View>

        {/* Summary */}
        <Card style={styles.summaryCard}>
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
        </Card>

        {/* Refund section — buyer only */}
        {user && order.buyerId === user.id && (
          <>
            {order.refundApprovedAt ? (
              <View style={styles.refundBadgeWrapper}>
                <ColorBadge label="Refund approved" bg={colors.secondarySoft} text={colors.secondary} />
              </View>
            ) : order.refundRequestedAt ? (
              <View style={styles.refundBadgeWrapper}>
                <ColorBadge label="Refund requested" bg={colors.accentSoft} text={colors.text} />
              </View>
            ) : (
              <>
                {order.refundDeclinedAt ? (
                  <View style={styles.refundBadgeWrapper}>
                    <ColorBadge label="Refund declined" bg={colors.dangerSoft} text={colors.danger} />
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
    backgroundColor: colors.bg,
  },
  container: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxxl * 1.5,
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
  banner: {
    borderRadius: radii.md,
    padding: spacing.md + 2,
    marginBottom: spacing.xxl,
    alignItems: "center",
  },
  bannerText: {
    fontSize: type.body.fontSize + 1,
    fontWeight: "700",
  },
  orderId: {
    fontSize: type.section.fontSize,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.xs,
  },
  orderDate: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.xxl,
  },
  section: {
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    fontSize: type.caption.fontSize + 2,
    fontWeight: "700",
    color: colors.primary,
    marginBottom: spacing.sm + 2,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  lineCard: {
    marginBottom: spacing.sm,
  },
  lineName: {
    fontSize: type.body.fontSize,
    fontWeight: "600",
    color: colors.text,
    marginBottom: spacing.sm - 2,
  },
  lineRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  lineDetail: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
  lineTotal: {
    fontSize: type.caption.fontSize + 1,
    fontWeight: "700",
    color: colors.primary,
  },
  summaryCard: {
    gap: spacing.sm + 2,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  summaryLabel: {
    fontSize: type.caption.fontSize + 1,
    color: colors.textMuted,
  },
  summaryValue: {
    fontSize: type.caption.fontSize + 1,
    color: colors.text,
    fontWeight: "500",
  },
  summaryTotalRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm + 2,
  },
  summaryTotalLabel: {
    fontSize: type.body.fontSize + 1,
    fontWeight: "700",
    color: colors.text,
  },
  summaryTotalValue: {
    fontSize: type.section.fontSize - 1,
    fontWeight: "700",
    color: colors.primary,
  },
  // Refund affordance
  refundButton: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.pop,
    alignItems: "center",
  },
  refundButtonPressed: {
    backgroundColor: colors.popSoft,
  },
  refundButtonDisabled: {
    opacity: 0.5,
  },
  refundButtonText: {
    color: colors.pop,
    fontSize: type.body.fontSize,
    fontWeight: "600",
  },
  refundBadgeWrapper: {
    marginTop: spacing.lg,
    alignItems: "flex-start",
  },
  fulfillmentRow: {
    gap: spacing.xs,
  },
  fulfillmentLabel: {
    fontSize: type.caption.fontSize + 1,
    color: colors.text,
    fontWeight: "500",
  },
  fulfillmentAddress: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
});
