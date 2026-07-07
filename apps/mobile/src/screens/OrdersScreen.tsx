/**
 * OrdersScreen — buyer order history.
 *
 * Fetches trpc.orders.listMine (newest first).
 * Two-segment toggle: Active (pending_payment, paid) | History (fulfilled, cancelled,
 * refunded, disputed). Filter is applied client-side — no extra network round-trip.
 * FlatList: short order id, created date, total, status pill.
 * Tap → navigate to OrderDetail.
 * States: loading, error, empty ("No orders yet"), list.
 *
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { OrderStatus } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { StatusPill } from "../components/StatusPill";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";
import { colors, radii, spacing, type } from "../theme";

type Props = NativeStackScreenProps<AuthedStackParamList, "Orders">;

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = "active" | "history";

// ---------------------------------------------------------------------------
// Status → tab mapping (exhaustive over OrderStatus)
//
// Using Record<OrderStatus, Tab> forces TypeScript to demand an entry for every
// member of the OrderStatus union. If a new status is added to @homegrown/shared
// without updating this map, the file will fail to compile.
// ---------------------------------------------------------------------------

const STATUS_TAB: Record<OrderStatus, Tab> = {
  pending_payment: "active",
  paid:            "active",
  fulfilled:       "history",
  cancelled:       "history",
  refunded:        "history",
  disputed:        "history",
};

// ---------------------------------------------------------------------------
// OrdersScreen
// ---------------------------------------------------------------------------

export function OrdersScreen({ navigation }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("active");

  const { data: orders, isLoading, error, refetch } = trpc.orders.listMine.useQuery();

  // --- Loading state ---
  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // --- Error state ---
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

  // --- Derive counts for each tab ---
  const allOrders = orders ?? [];
  const activeOrders  = allOrders.filter((o) => STATUS_TAB[o.status] === "active");
  const historyOrders = allOrders.filter((o) => STATUS_TAB[o.status] === "history");

  const tabData = activeTab === "active" ? activeOrders : historyOrders;

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Segmented toggle */}
      <View style={styles.segmentRow}>
        <Pressable
          style={[styles.segment, activeTab === "active" ? styles.segmentActive : null]}
          onPress={() => setActiveTab("active")}
        >
          <Text
            style={[
              styles.segmentText,
              activeTab === "active" ? styles.segmentTextActive : null,
            ]}
          >
            {`Active (${activeOrders.length.toString()})`}
          </Text>
        </Pressable>

        <Pressable
          style={[styles.segment, activeTab === "history" ? styles.segmentActive : null]}
          onPress={() => setActiveTab("history")}
        >
          <Text
            style={[
              styles.segmentText,
              activeTab === "history" ? styles.segmentTextActive : null,
            ]}
          >
            {`History (${historyOrders.length.toString()})`}
          </Text>
        </Pressable>
      </View>

      {/* Per-tab empty state */}
      {tabData.length === 0 ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>
            {activeTab === "active" ? "No active orders." : "No past orders."}
          </Text>
          <Text style={styles.stateSubText}>
            {activeTab === "active"
              ? "Orders awaiting payment or fulfillment will appear here."
              : "Fulfilled, cancelled, and refunded orders will appear here."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={tabData}
          keyExtractor={(o) => o.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <Pressable onPress={() => navigation.navigate("OrderDetail", { orderId: item.id })}>
              <Card style={styles.orderCard}>
                <View style={styles.orderRow}>
                  <Text style={styles.orderId}>#{item.id.slice(0, 8).toUpperCase()}</Text>
                  <StatusPill status={item.status} preparationState={item.preparationState} />
                </View>
                <View style={styles.orderRow}>
                  <Text style={styles.orderDate}>
                    {new Date(item.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </Text>
                  <Text style={styles.orderTotal}>${formatCents(item.totalCents)}</Text>
                </View>
              </Card>
            </Pressable>
          )}
        />
      )}
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
  segmentRow: {
    flexDirection: "row",
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
  },
  segmentActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  segmentText: {
    fontSize: type.caption.fontSize + 1,
    color: colors.textMuted,
    fontWeight: "500",
  },
  segmentTextActive: {
    color: colors.onPrimary,
    fontWeight: "700",
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
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
});
