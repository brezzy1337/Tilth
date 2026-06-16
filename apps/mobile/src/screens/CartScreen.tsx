/**
 * CartScreen — buyer cart with PaymentSheet checkout.
 *
 * Lists line items with quantity stepper (−/+), line totals, and remove.
 * Shows store name and running subtotal.
 * "Pay" button runs the full PaymentSheet flow:
 *   1. orders.create → (order, clientSecret)
 *   2. initPaymentSheet
 *   3. presentPaymentSheet
 *   On Canceled: abort quietly.
 *   On any other presentErr: show error and stop.
 *   On success: clearCart → navigate to OrderDetail immediately.
 *   OrderDetailScreen is the single confirmer (it polls orders.get while
 *   status === "pending_payment" via refetchInterval).
 *
 * Unmount-safe: mountedRef guards every setState that runs after an await.
 *
 * React Native only — no DOM elements.
 * Money: integer cents throughout; formatCents for display.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useStripe } from "@stripe/stripe-react-native";
import { trpc } from "../api/trpc";
import { useCart } from "../cart/CartContext";
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";

type Props = NativeStackScreenProps<AuthedStackParamList, "Cart">;

// ---------------------------------------------------------------------------
// CartScreen
// ---------------------------------------------------------------------------

export function CartScreen({ navigation }: Props) {
  const { items, storeName, itemCount, subtotalCents, setQuantity, removeItem, clearCart } =
    useCart();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const createOrder = trpc.orders.create.useMutation();

  const [checkoutStatus, setCheckoutStatus] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  // Unmount guard — prevents setState calls on an unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleCheckout() {
    if (items.length === 0) return;

    setIsCheckingOut(true);
    setCheckoutError(null);
    setCheckoutStatus("Creating order…");

    try {
      // Step 1: create order
      const orderItems = items.map((i) => ({ listingId: i.listingId, quantity: i.quantity }));
      let orderResult: Awaited<ReturnType<typeof createOrder.mutateAsync>>;
      try {
        orderResult = await createOrder.mutateAsync({ items: orderItems });
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : "Could not create order. Try again.";
        setCheckoutError(msg);
        setCheckoutStatus(null);
        setIsCheckingOut(false);
        return;
      }

      const { order, clientSecret } = orderResult;

      // Step 2: init PaymentSheet
      if (!mountedRef.current) return;
      setCheckoutStatus("Initialising payment…");
      const { error: initErr } = await initPaymentSheet({
        merchantDisplayName: "HomeGrown",
        paymentIntentClientSecret: clientSecret,
        returnURL: "homegrown://stripe-redirect",
      });
      if (initErr) {
        if (!mountedRef.current) return;
        setCheckoutError(initErr.message ?? "Could not initialise payment.");
        setCheckoutStatus(null);
        setIsCheckingOut(false);
        return;
      }

      // Step 3: present PaymentSheet
      if (!mountedRef.current) return;
      setCheckoutStatus("Waiting for payment…");
      const { error: presentErr } = await presentPaymentSheet();
      if (presentErr) {
        if (presentErr.code === "Canceled") {
          // Buyer dismissed — quiet abort
          if (!mountedRef.current) return;
          setCheckoutStatus(null);
          setIsCheckingOut(false);
          return;
        }
        if (!mountedRef.current) return;
        setCheckoutError(presentErr.message ?? "Payment failed. Please try again.");
        setCheckoutStatus(null);
        setIsCheckingOut(false);
        return;
      }

      // Payment sheet completed without error.
      // Navigate immediately — OrderDetailScreen is the single confirmer
      // (it polls orders.get via refetchInterval while status === "pending_payment").
      clearCart();
      navigation.replace("OrderDetail", { orderId: order.id });
    } finally {
      if (mountedRef.current) {
        setIsCheckingOut(false);
        setCheckoutStatus(null);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------

  if (itemCount === 0) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Your cart is empty.</Text>
          <Text style={styles.stateSubText}>Browse nearby produce to add items.</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ---------------------------------------------------------------------------
  // Cart with items
  // ---------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        {storeName ? <Text style={styles.storeLabel}>From: {storeName}</Text> : null}

        <FlatList
          data={items}
          keyExtractor={(item) => item.listingId}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <View style={styles.lineCard}>
              <View style={styles.lineHeader}>
                <Text style={styles.lineName}>{item.name}</Text>
                <Pressable onPress={() => removeItem(item.listingId)} style={styles.removeButton}>
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              </View>
              <Text style={styles.linePrice}>
                ${formatCents(item.priceCents)} / {item.unit}
              </Text>
              <View style={styles.stepperRow}>
                <Pressable
                  style={styles.stepperButton}
                  onPress={() => setQuantity(item.listingId, item.quantity - 1)}
                  disabled={item.quantity <= 1}
                >
                  <Text style={styles.stepperText}>−</Text>
                </Pressable>
                <Text style={styles.stepperQty}>{item.quantity}</Text>
                <Pressable
                  style={styles.stepperButton}
                  onPress={() => setQuantity(item.listingId, item.quantity + 1)}
                  disabled={item.quantity >= Math.min(item.available, 1000)}
                >
                  <Text style={styles.stepperText}>+</Text>
                </Pressable>
                <Text style={styles.lineTotal}>
                  = ${formatCents(item.priceCents * item.quantity)}
                </Text>
              </View>
            </View>
          )}
        />

        {/* Subtotal */}
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Subtotal</Text>
          <Text style={styles.summaryValue}>${formatCents(subtotalCents)}</Text>
        </View>

        {/* Checkout status / error */}
        {checkoutStatus ? (
          <Text style={styles.statusText}>{checkoutStatus}</Text>
        ) : null}
        {checkoutError ? (
          <Text style={styles.errorText}>{checkoutError}</Text>
        ) : null}

        {/* Pay button */}
        <Pressable
          style={[styles.payButton, isCheckingOut ? styles.payButtonDisabled : null]}
          onPress={() => void handleCheckout()}
          disabled={isCheckingOut}
        >
          {isCheckingOut ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.payButtonText}>Pay ${formatCents(subtotalCents)}</Text>
          )}
        </Pressable>
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
  storeLabel: {
    fontSize: 14,
    color: "#2d6a4f",
    fontWeight: "600",
    marginBottom: 16,
  },
  lineCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
  },
  lineHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  lineName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1a1a1a",
    flex: 1,
  },
  removeButton: {
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  removeText: {
    fontSize: 12,
    color: "#c0392b",
    fontWeight: "600",
  },
  linePrice: {
    fontSize: 13,
    color: "#666",
    marginBottom: 8,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#2d6a4f",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperText: {
    fontSize: 18,
    color: "#2d6a4f",
    fontWeight: "600",
    lineHeight: 22,
  },
  stepperQty: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
    minWidth: 24,
    textAlign: "center",
  },
  lineTotal: {
    fontSize: 14,
    color: "#2d6a4f",
    fontWeight: "700",
    marginLeft: "auto",
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    marginBottom: 20,
    paddingHorizontal: 4,
  },
  summaryLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#2d6a4f",
  },
  statusText: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    marginBottom: 10,
  },
  errorText: {
    fontSize: 13,
    color: "#c0392b",
    textAlign: "center",
    marginBottom: 10,
  },
  payButton: {
    backgroundColor: "#2d6a4f",
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: "center",
  },
  payButtonDisabled: {
    opacity: 0.6,
  },
  payButtonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
});
