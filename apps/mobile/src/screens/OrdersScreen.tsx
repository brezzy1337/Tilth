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
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";

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
          <ActivityIndicator size="large" color="#2d6a4f" />
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
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
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
            <Pressable
              style={styles.orderCard}
              onPress={() => navigation.navigate("OrderDetail", { orderId: item.id })}
            >
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
  segmentRow: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 4,
    gap: 8,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ccc",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  segmentActive: {
    backgroundColor: "#2d6a4f",
    borderColor: "#2d6a4f",
  },
  segmentText: {
    fontSize: 14,
    color: "#555",
    fontWeight: "500",
  },
  segmentTextActive: {
    color: "#fff",
    fontWeight: "700",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
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
});
