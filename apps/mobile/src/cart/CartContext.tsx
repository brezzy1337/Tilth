/**
 * CartContext — in-memory single-store cart for buyers.
 *
 * Rules:
 *   - In-memory only; no persistence (explicit product decision).
 *   - Single-store invariant: addItem rejects listings from a different store
 *     and returns { ok: false, reason: "different-store" } so the caller can
 *     prompt the user to start a new cart. The context never shows its own Alert.
 *   - Money is always integer cents; no floats.
 *   - Available quantity (from NearbyListing.quantity) is the stock cap for setQuantity.
 *
 * Exported: CartProvider, useCart.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NearbyListing } from "@homegrown/shared";
import { useAuth } from "../auth/AuthContext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CartLineItem = {
  listingId: string;
  name: string;
  priceCents: number;
  unit: string;
  storeId: string;
  storeName: string;
  quantity: number;
  /** Available stock cap from the listing at the time it was added. */
  available: number;
};

export type AddItemResult =
  | { ok: true }
  | { ok: false; reason: "different-store"; cartStoreName: string }
  | { ok: false; reason: "sold-out" };

export type CartContextValue = {
  items: CartLineItem[];
  storeId: string | null;
  storeName: string | null;
  /** Sum of all line item quantities. */
  itemCount: number;
  /** Sum of priceCents × quantity across all items (integer cents). */
  subtotalCents: number;
  /**
   * Add a listing to the cart. If the listing is sold out, returns
   * { ok: false, reason: "sold-out" }. If the cart is non-empty and the
   * listing belongs to a different store, returns
   * { ok: false, reason: "different-store" }. Otherwise increments quantity
   * if the item is already in the cart, up to Math.min(available, 1000).
   */
  addItem: (listing: NearbyListing) => AddItemResult;
  /**
   * Set the quantity of an item. Clamped to [1, min(available, 1000)].
   * No-op if the listing is not in the cart.
   */
  setQuantity: (listingId: string, qty: number) => void;
  removeItem: (listingId: string) => void;
  clearCart: () => void;
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const CartContext = createContext<CartContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartLineItem[]>([]);

  // itemsRef always reflects the latest committed items array, eliminating
  // stale-closure reads in addItem (which must read current state synchronously
  // before the async setState settles).
  const itemsRef = useRef<CartLineItem[]>([]);

  // Wrap setItems so itemsRef is kept in sync inside every updater.
  const setItemsAndRef = useCallback(
    (updater: (prev: CartLineItem[]) => CartLineItem[]) => {
      setItems((prev) => {
        const next = updater(prev);
        itemsRef.current = next;
        return next;
      });
    },
    [],
  );

  // Clear cart on sign-out — decouples cleanup from AuthContext.
  const { status: authStatus } = useAuth();
  useEffect(() => {
    if (authStatus === "signedOut") {
      setItemsAndRef(() => []);
    }
  }, [authStatus, setItemsAndRef]);

  const addItem = useCallback((listing: NearbyListing): AddItemResult => {
    // Defense-in-depth: reject sold-out listings before touching state.
    if (listing.quantity === 0) {
      return { ok: false, reason: "sold-out" };
    }

    // Single-store invariant check — read from ref, not the closed-over `items`,
    // so rapid successive calls all see the most-recently committed state.
    const currentItems = itemsRef.current;
    const currentStoreId = currentItems.length > 0 ? currentItems[0]!.storeId : null;
    if (currentStoreId !== null && currentStoreId !== listing.storeId) {
      return {
        ok: false,
        reason: "different-store",
        cartStoreName: currentItems[0]!.storeName,
      };
    }

    setItemsAndRef((prev) => {
      // Second line of defense inside the updater — prev is the latest committed
      // state, so two concurrent taps cannot both sneak through.
      const prevStoreId = prev.length > 0 ? prev[0]!.storeId : null;
      if (prevStoreId !== null && prevStoreId !== listing.storeId) {
        // Reject silently; caller already got ok:true from the synchronous guard
        // above, but we prevent a corrupt item list. Return prev unchanged.
        return prev;
      }

      const existing = prev.find((i) => i.listingId === listing.id);
      if (existing) {
        // Increment quantity, clamped to min(available, 1000)
        const cap = Math.min(listing.quantity, 1000);
        return prev.map((i) =>
          i.listingId === listing.id
            ? { ...i, quantity: Math.min(i.quantity + 1, cap) }
            : i,
        );
      }
      // New item — quantity starts at 1
      const cap = Math.min(listing.quantity, 1000);
      const newItem: CartLineItem = {
        listingId: listing.id,
        name: listing.name,
        priceCents: listing.priceCents,
        unit: listing.unit,
        storeId: listing.storeId,
        storeName: listing.storeName,
        quantity: Math.min(1, cap),
        available: listing.quantity,
      };
      return [...prev, newItem];
    });

    return { ok: true };
  }, [setItemsAndRef]);

  const setQuantity = useCallback((listingId: string, qty: number) => {
    setItemsAndRef((prev) =>
      prev.map((i) => {
        if (i.listingId !== listingId) return i;
        const cap = Math.min(i.available, 1000);
        return { ...i, quantity: Math.max(1, Math.min(qty, cap)) };
      }),
    );
  }, [setItemsAndRef]);

  const removeItem = useCallback((listingId: string) => {
    setItemsAndRef((prev) => prev.filter((i) => i.listingId !== listingId));
  }, [setItemsAndRef]);

  const clearCart = useCallback(() => {
    setItemsAndRef(() => []);
  }, [setItemsAndRef]);

  const storeId = items.length > 0 ? items[0]!.storeId : null;
  const storeName = items.length > 0 ? items[0]!.storeName : null;
  const itemCount = useMemo(() => items.reduce((sum, i) => sum + i.quantity, 0), [items]);
  const subtotalCents = useMemo(
    () => items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0),
    [items],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      storeId,
      storeName,
      itemCount,
      subtotalCents,
      addItem,
      setQuantity,
      removeItem,
      clearCart,
    }),
    [items, storeId, storeName, itemCount, subtotalCents, addItem, setQuantity, removeItem, clearCart],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error("useCart must be used inside <CartProvider>");
  }
  return ctx;
}
