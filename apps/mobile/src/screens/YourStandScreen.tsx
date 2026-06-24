/**
 * YourStandScreen — seller dashboard.
 *
 * Flow:
 *   1. If the user has no store → show create-store form
 *      (createStoreInput: name, logo?, about?)
 *   2. Once a store exists:
 *      a. Payments section: Stripe Connect onboarding (FIRST priority)
 *         connect.status.useQuery() + connect.createOnboardingLink.useMutation()
 *         → opens Stripe hosted onboarding via expo-web-browser
 *         → REFETCHES connect.status after browser closes (webhooks are truth)
 *      b. Location section: setStoreLocationInput (address, city, state, zip)
 *         → geo.setStoreLocation.useMutation()
 *      c. Listings section: list existing + add-listing form
 *         (createListingInput: name, category, priceCents, quantity, unit)
 *         Price entered in dollars → converted to integer cents before submit.
 *         AddListingForm is GATED behind chargesEnabled; existing listings always show.
 *
 * Contracts from @homegrown/shared — never redeclared here.
 * No form library — useState + shared zod safeParse.
 * FormField reusable component for label + TextInput + inline error.
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import * as WebBrowser from "expo-web-browser";
import {
  createStoreInput,
  setStoreLocationInput,
  createListingInput,
  listingCategory,
  type ListingCategory,
  type ListingUnit,
} from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { FormField } from "../components/FormField";
import type { AuthedNavigationProp } from "../navigation/types";
import { capitalise } from "../utils/text";
import { formatCents } from "../utils/money";

// ---------------------------------------------------------------------------
// Category and unit option arrays derived from the shared enums
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS: readonly ListingCategory[] = listingCategory.options;

const UNIT_OPTIONS: ListingUnit[] = ["each", "lb", "oz", "bunch", "dozen", "jar", "pint", "quart"];

// ---------------------------------------------------------------------------
// CreateStoreSection
// ---------------------------------------------------------------------------

function CreateStoreSection({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [logo, setLogo] = useState("");
  const [about, setAbout] = useState("");
  const [errors, setErrors] = useState<{
    name?: string;
    logo?: string;
    about?: string;
  }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const mutation = trpc.stores.create.useMutation({
    onSuccess: () => {
      onCreated();
    },
    onError: (err) => {
      setServerError(err.message ?? "Could not create store. Try again.");
    },
  });

  function handleSubmit() {
    setErrors({});
    setServerError(null);

    const result = createStoreInput.safeParse({
      name,
      logo: logo.trim() !== "" ? logo.trim() : undefined,
      about: about.trim() !== "" ? about.trim() : undefined,
    });

    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setErrors({
        name: flat.name?.[0],
        logo: flat.logo?.[0],
        about: flat.about?.[0],
      });
      return;
    }

    mutation.mutate(result.data);
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Create Your Stand</Text>
      <Text style={styles.sectionSubtitle}>Set up your store to start selling local produce.</Text>

      <FormField
        label="Stand Name"
        value={name}
        onChangeText={setName}
        error={errors.name}
        placeholder="e.g. Sunny Acres Farm"
        autoCapitalize="words"
      />
      <FormField
        label="Logo URL (optional)"
        value={logo}
        onChangeText={setLogo}
        error={errors.logo}
        placeholder="https://example.com/logo.png"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <FormField
        label="About (optional)"
        value={about}
        onChangeText={setAbout}
        error={errors.about}
        placeholder="Tell buyers about your farm..."
        multiline
        numberOfLines={3}
        style={styles.multilineInput}
      />

      {serverError ? <Text style={styles.serverError}>{serverError}</Text> : null}

      <Pressable
        style={[styles.button, mutation.isPending ? styles.buttonDisabled : null]}
        onPress={handleSubmit}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Create Stand</Text>
        )}
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// PaymentsSection — Stripe Connect onboarding for sellers
// Placed ABOVE LocationSection (payment setup is the seller's first priority).
//
// States:
//   Not started (!detailsSubmitted): prompt + "Set up payments" button
//   In progress (detailsSubmitted && !chargesEnabled): review message + "Continue setup"
//   Ready (chargesEnabled): success card
//
// After the Stripe hosted onboarding browser closes, connect.status is REFETCHED.
// The browser closing is NOT treated as success — the status booleans are the
// authoritative source of truth (driven by the account.updated webhook).
// ---------------------------------------------------------------------------

function PaymentsSection() {
  const utils = trpc.useUtils();
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);

  const {
    data: status,
    isLoading,
    error,
    refetch,
  } = trpc.connect.status.useQuery();

  const onboardingMutation = trpc.connect.createOnboardingLink.useMutation({
    onSuccess: async (data) => {
      setBrowserError(null);
      setIsBrowserOpen(true);
      try {
        // Open Stripe hosted onboarding in an in-app browser.
        // openBrowserAsync resolves when the user dismisses the browser —
        // NOT necessarily after completing onboarding. Refetch status after
        // close; the account.updated webhook is the source of truth.
        await WebBrowser.openBrowserAsync(data.url);
      } finally {
        setIsBrowserOpen(false);
        // Always refetch after browser closes — webhooks may have updated state.
        void utils.connect.status.invalidate();
      }
    },
    onError: (err) => {
      setBrowserError(err.message ?? "Could not start onboarding. Try again.");
    },
  });

  const dashboardLinkMutation = trpc.connect.dashboardLink.useMutation({
    onSuccess: async (data) => {
      await WebBrowser.openBrowserAsync(data.url);
    },
    onError: (err) => {
      Alert.alert("Could not open dashboard", err.message ?? "Please try again.");
    },
  });

  function handleSetupPress() {
    setBrowserError(null);
    onboardingMutation.mutate({});
  }

  const isPending = onboardingMutation.isPending || isBrowserOpen;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Payments</Text>

      {/* Loading state */}
      {isLoading && <ActivityIndicator size="small" color="#2d6a4f" style={styles.loader} />}

      {/* Error loading status */}
      {error && !isLoading ? (
        <View>
          <Text style={styles.serverError}>Could not load payment status: {error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Mutation error (opening onboarding link) */}
      {browserError ? (
        <View>
          <Text style={styles.serverError}>{browserError}</Text>
        </View>
      ) : null}

      {/* State: Ready — charges enabled */}
      {status?.chargesEnabled ? (
        <View>
          <View style={styles.successCard}>
            <Text style={styles.successText}>
              Payments active — you can accept orders.
              {status.payoutsEnabled ? " Payouts are also enabled." : ""}
            </Text>
          </View>
          {status.detailsSubmitted ? (
            <Pressable
              style={[
                styles.button,
                dashboardLinkMutation.isPending ? styles.buttonDisabled : null,
              ]}
              onPress={() => dashboardLinkMutation.mutate()}
              disabled={dashboardLinkMutation.isPending}
            >
              {dashboardLinkMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.buttonText}>{"View earnings & payouts"}</Text>
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* State: In progress — details submitted but charges not yet enabled */}
      {status && status.detailsSubmitted && !status.chargesEnabled ? (
        <View>
          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>Payment setup in review</Text>
            <Text style={styles.sectionSubtitle}>
              Stripe is verifying your details. This usually takes a few minutes. You can continue
              your setup or check back soon.
            </Text>
          </View>
          <Pressable
            style={[styles.button, isPending ? styles.buttonDisabled : null]}
            onPress={handleSetupPress}
            disabled={isPending}
          >
            {isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Continue setup</Text>
            )}
          </Pressable>
          <Pressable
            style={styles.retryButton}
            onPress={() => void refetch()}
            disabled={isLoading}
          >
            <Text style={styles.retryText}>Refresh status</Text>
          </Pressable>
        </View>
      ) : null}

      {/* State: Not started — no details submitted yet */}
      {status && !status.detailsSubmitted ? (
        <View>
          <Text style={styles.sectionSubtitle}>
            Connect a payout account with Stripe to start selling.
          </Text>
          <Pressable
            style={[styles.button, isPending ? styles.buttonDisabled : null]}
            onPress={handleSetupPress}
            disabled={isPending}
          >
            {isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Set up payments</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// LocationSection
// ---------------------------------------------------------------------------

function LocationSection() {
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [errors, setErrors] = useState<{
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
  }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAddress, setSavedAddress] = useState<string | null>(null);

  const mutation = trpc.geo.setStoreLocation.useMutation({
    onSuccess: (data) => {
      setSavedAddress(`${data.address}, ${data.city}, ${data.state} ${data.zip}`);
      setServerError(null);
    },
    onError: (err) => {
      setServerError(err.message ?? "Could not save location. Try again.");
    },
  });

  function handleSubmit() {
    setErrors({});
    setServerError(null);
    setSavedAddress(null);

    const result = setStoreLocationInput.safeParse({ address, city, state, zip });
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setErrors({
        address: flat.address?.[0],
        city: flat.city?.[0],
        state: flat.state?.[0],
        zip: flat.zip?.[0],
      });
      return;
    }

    mutation.mutate(result.data);
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Stand Location</Text>

      {savedAddress ? (
        <View style={styles.successCard}>
          <Text style={styles.successText}>Location saved: {savedAddress}</Text>
        </View>
      ) : null}

      <FormField
        label="Street Address"
        value={address}
        onChangeText={setAddress}
        error={errors.address}
        placeholder="123 Farm Lane"
        autoCapitalize="words"
      />
      <FormField
        label="City"
        value={city}
        onChangeText={setCity}
        error={errors.city}
        placeholder="Springfield"
        autoCapitalize="words"
      />
      <FormField
        label="State"
        value={state}
        onChangeText={setState}
        error={errors.state}
        placeholder="CA"
        autoCapitalize="characters"
        maxLength={50}
      />
      <FormField
        label="ZIP Code"
        value={zip}
        onChangeText={setZip}
        error={errors.zip}
        placeholder="90210"
        keyboardType="number-pad"
        maxLength={12}
      />

      {serverError ? <Text style={styles.serverError}>{serverError}</Text> : null}

      <Pressable
        style={[styles.button, mutation.isPending ? styles.buttonDisabled : null]}
        onPress={handleSubmit}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Save Location</Text>
        )}
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// AddListingForm
// ---------------------------------------------------------------------------

function AddListingForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ListingCategory>("vegetable");
  const [priceDollars, setPriceDollars] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState<ListingUnit>("each");
  const [errors, setErrors] = useState<{
    name?: string;
    category?: string;
    priceCents?: string;
    quantity?: string;
    unit?: string;
  }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const mutation = trpc.listings.create.useMutation({
    onSuccess: () => {
      // Reset form
      setName("");
      setPriceDollars("");
      setQuantity("");
      setErrors({});
      setServerError(null);
      onAdded();
    },
    onError: (err) => {
      setServerError(err.message ?? "Could not add listing. Try again.");
    },
  });

  function handleSubmit() {
    setErrors({});
    setServerError(null);

    // Convert dollars (string) → integer cents
    const parsedDollars = parseFloat(priceDollars);
    const priceCents = Number.isFinite(parsedDollars) ? Math.round(parsedDollars * 100) : NaN;

    const parsedQuantity = parseInt(quantity, 10);

    const result = createListingInput.safeParse({
      name,
      category,
      priceCents,
      quantity: parsedQuantity,
      unit,
    });

    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setErrors({
        name: flat.name?.[0],
        category: flat.category?.[0],
        priceCents: flat.priceCents?.[0],
        quantity: flat.quantity?.[0],
        unit: flat.unit?.[0],
      });
      return;
    }

    mutation.mutate(result.data);
  }

  return (
    <View style={styles.addListingCard}>
      <Text style={styles.cardLabel}>Add a Listing</Text>

      <FormField
        label="Name"
        value={name}
        onChangeText={setName}
        error={errors.name}
        placeholder="e.g. Heirloom Tomatoes"
        autoCapitalize="words"
      />

      {/* Category picker */}
      <View style={styles.fieldGroup}>
        <Text style={styles.pickerLabel}>Category</Text>
        <View style={styles.chipRow}>
          {CATEGORY_OPTIONS.map((opt) => (
            <Pressable
              key={opt}
              style={[styles.chip, category === opt ? styles.chipActive : null]}
              onPress={() => setCategory(opt)}
            >
              <Text style={[styles.chipText, category === opt ? styles.chipTextActive : null]}>
                {capitalise(opt)}
              </Text>
            </Pressable>
          ))}
        </View>
        {errors.category ? <Text style={styles.fieldError}>{errors.category}</Text> : null}
      </View>

      <FormField
        label="Price (dollars)"
        value={priceDollars}
        onChangeText={setPriceDollars}
        error={errors.priceCents}
        placeholder="e.g. 3.50"
        keyboardType="decimal-pad"
      />

      <FormField
        label="Quantity"
        value={quantity}
        onChangeText={setQuantity}
        error={errors.quantity}
        placeholder="e.g. 12"
        keyboardType="number-pad"
      />

      {/* Unit picker */}
      <View style={styles.fieldGroup}>
        <Text style={styles.pickerLabel}>Unit</Text>
        <View style={styles.chipRow}>
          {UNIT_OPTIONS.map((opt) => (
            <Pressable
              key={opt}
              style={[styles.chip, unit === opt ? styles.chipActive : null]}
              onPress={() => setUnit(opt)}
            >
              <Text style={[styles.chipText, unit === opt ? styles.chipTextActive : null]}>
                {opt}
              </Text>
            </Pressable>
          ))}
        </View>
        {errors.unit ? <Text style={styles.fieldError}>{errors.unit}</Text> : null}
      </View>

      {serverError ? <Text style={styles.serverError}>{serverError}</Text> : null}

      <Pressable
        style={[styles.button, mutation.isPending ? styles.buttonDisabled : null]}
        onPress={handleSubmit}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Add Listing</Text>
        )}
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// ListingsSection
// chargesEnabled: when false, existing listings are shown read-only and
// AddListingForm is replaced with a notice prompting payment setup.
// ---------------------------------------------------------------------------

function ListingsSection({
  storeId,
  chargesEnabled,
}: {
  storeId: string;
  chargesEnabled: boolean;
}) {
  const utils = trpc.useUtils();
  const {
    data: listings,
    isLoading,
    error,
    refetch,
  } = trpc.listings.listByStore.useQuery({ storeId });

  function handleListingAdded() {
    void utils.listings.listByStore.invalidate({ storeId });
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Your Listings</Text>

      {isLoading && <ActivityIndicator size="small" color="#2d6a4f" style={styles.loader} />}

      {error ? (
        <View>
          <Text style={styles.serverError}>Could not load listings: {error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {listings && listings.length === 0 ? (
        <Text style={styles.emptyText}>No listings yet. Add your first one below.</Text>
      ) : null}

      {listings && listings.length > 0
        ? listings.map((item) => (
            <View key={item.id} style={styles.listingCard}>
              <Text style={styles.listingName}>{item.name}</Text>
              <Text style={styles.listingMeta}>
                {capitalise(item.category)} · ${formatCents(item.priceCents)}/{item.unit} ·
                qty {item.quantity}
              </Text>
            </View>
          ))
        : null}

      {/* Gate AddListingForm behind chargesEnabled. Show a notice when not enabled. */}
      {chargesEnabled ? (
        <AddListingForm onAdded={handleListingAdded} />
      ) : (
        <View style={styles.gateCard}>
          <Text style={styles.gateCardText}>Set up payments to start listing produce.</Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// StoreView — shown once a store exists
// Queries connect.status once here and passes chargesEnabled down to avoid
// double-fetching (tRPC/react-query dedupes shared query keys, so a separate
// useQuery call in PaymentsSection is also fine — we keep it separate there
// for self-contained loading/error handling).
// ---------------------------------------------------------------------------

function StoreView({ storeId, storeName }: { storeId: string; storeName: string }) {
  // connect.status is also queried inside PaymentsSection; react-query dedupes
  // the request. We query it here too so ListingsSection can receive chargesEnabled
  // without prop-drilling through PaymentsSection.
  const { data: connectStatusData } = trpc.connect.status.useQuery();
  const chargesEnabled = connectStatusData?.chargesEnabled ?? false;
  const navigation = useNavigation<AuthedNavigationProp>();

  return (
    <>
      <View style={styles.storeHeader}>
        <Text style={styles.storeName}>{storeName}</Text>
        <Pressable
          style={styles.ordersButton}
          onPress={() => navigation.navigate("StoreOrders")}
        >
          <Text style={styles.ordersButtonText}>Orders / Refund requests</Text>
        </Pressable>
      </View>
      <PaymentsSection />
      <LocationSection />
      <ListingsSection storeId={storeId} chargesEnabled={chargesEnabled} />
    </>
  );
}

// ---------------------------------------------------------------------------
// YourStandScreen — root
// ---------------------------------------------------------------------------

export function YourStandScreen() {
  const utils = trpc.useUtils();
  const { data: store, isLoading, error, refetch } = trpc.stores.getMine.useQuery();

  function handleStoreCreated() {
    void utils.stores.getMine.invalidate();
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Text style={styles.pageTitle}>Your Stand</Text>

          {isLoading && <ActivityIndicator size="large" color="#2d6a4f" style={styles.loader} />}

          {error ? (
            <View>
              <Text style={styles.serverError}>Could not load store: {error.message}</Text>
              <Pressable style={styles.retryButton} onPress={() => void refetch()}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          {!isLoading && !error && store === null ? (
            <CreateStoreSection onCreated={handleStoreCreated} />
          ) : null}

          {store ? <StoreView storeId={store.id} storeName={store.name} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: {
    flex: 1,
    backgroundColor: "#f7f9f7",
  },
  container: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 48,
    gap: 0,
  },
  pageTitle: {
    fontSize: 26,
    fontWeight: "bold",
    color: "#2d6a4f",
    marginBottom: 20,
  },
  loader: {
    marginTop: 40,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#2d6a4f",
    marginBottom: 6,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: "#666",
    marginBottom: 16,
  },
  storeHeader: {
    marginBottom: 20,
    gap: 10,
  },
  storeName: {
    fontSize: 22,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  ordersButton: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2d6a4f",
  },
  ordersButtonText: {
    color: "#2d6a4f",
    fontSize: 14,
    fontWeight: "600",
  },
  successCard: {
    backgroundColor: "#e8f5e9",
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  successText: {
    fontSize: 13,
    color: "#2d6a4f",
    fontWeight: "500",
  },
  infoCard: {
    backgroundColor: "#fff8e1",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
  },
  infoCardTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#92400e",
    marginBottom: 4,
  },
  gateCard: {
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
    padding: 14,
    marginTop: 12,
    alignItems: "center",
  },
  gateCardText: {
    fontSize: 14,
    color: "#6b7280",
    textAlign: "center",
  },
  emptyText: {
    fontSize: 14,
    color: "#888",
    marginBottom: 16,
  },
  listingCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 1,
  },
  listingName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1a1a1a",
    marginBottom: 2,
  },
  listingMeta: {
    fontSize: 13,
    color: "#666",
  },
  addListingCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 1,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 16,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  pickerLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#444",
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ccc",
    backgroundColor: "#fafafa",
  },
  chipActive: {
    backgroundColor: "#2d6a4f",
    borderColor: "#2d6a4f",
  },
  chipText: {
    fontSize: 13,
    color: "#555",
  },
  chipTextActive: {
    color: "#fff",
    fontWeight: "600",
  },
  fieldError: {
    marginTop: 4,
    fontSize: 12,
    color: "#c0392b",
  },
  serverError: {
    marginBottom: 12,
    fontSize: 13,
    color: "#c0392b",
    textAlign: "center",
  },
  button: {
    backgroundColor: "#2d6a4f",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  retryButton: {
    alignSelf: "center",
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
  multilineInput: {
    minHeight: 80,
    textAlignVertical: "top",
  },
});
