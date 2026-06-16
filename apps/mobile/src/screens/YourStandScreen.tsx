/**
 * YourStandScreen — seller dashboard.
 *
 * Flow:
 *   1. If the user has no store → show create-store form
 *      (createStoreInput: name, logo?, about?)
 *   2. Once a store exists:
 *      a. Location section: setStoreLocationInput (address, city, state, zip)
 *         → geo.setStoreLocation.useMutation()
 *      b. Listings section: list existing + add-listing form
 *         (createListingInput: name, category, priceCents, quantity, unit)
 *         Price entered in dollars → converted to integer cents before submit.
 *
 * Contracts from @homegrown/shared — never redeclared here.
 * No form library — useState + shared zod safeParse.
 * FormField reusable component for label + TextInput + inline error.
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  createStoreInput,
  setStoreLocationInput,
  createListingInput,
  type ListingCategory,
  type ListingUnit,
} from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { FormField } from "../components/FormField";

// ---------------------------------------------------------------------------
// Category and unit option arrays derived from the shared enums
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS: ListingCategory[] = ["vegetable", "fruit", "herb", "egg", "honey", "other"];

const UNIT_OPTIONS: ListingUnit[] = ["each", "lb", "oz", "bunch", "dozen", "jar", "pint", "quart"];

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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
// LocationSection
// ---------------------------------------------------------------------------

function LocationSection({ storeId }: { storeId: string }) {
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

  // storeId is provided from parent but setStoreLocation infers it server-side
  // from the session — we don't pass it in the input. Including it here only
  // for future use or logging; the mutation payload follows setStoreLocationInput.
  void storeId;

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

function AddListingForm({ storeId, onAdded }: { storeId: string; onAdded: () => void }) {
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

  // storeId not in createListingInput — server infers from session.
  void storeId;

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
      priceCents: Number.isNaN(priceCents) ? priceCents : priceCents,
      quantity: Number.isNaN(parsedQuantity) ? parsedQuantity : parsedQuantity,
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
// ---------------------------------------------------------------------------

function ListingsSection({ storeId }: { storeId: string }) {
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
                {capitalise(item.category)} · ${(item.priceCents / 100).toFixed(2)}/{item.unit} ·
                qty {item.quantity}
              </Text>
            </View>
          ))
        : null}

      <AddListingForm storeId={storeId} onAdded={handleListingAdded} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// StoreView — shown once a store exists
// ---------------------------------------------------------------------------

function StoreView({ storeId, storeName }: { storeId: string; storeName: string }) {
  return (
    <>
      <View style={styles.storeHeader}>
        <Text style={styles.storeName}>{storeName}</Text>
      </View>
      <LocationSection storeId={storeId} />
      <ListingsSection storeId={storeId} />
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
  },
  storeName: {
    fontSize: 22,
    fontWeight: "700",
    color: "#1a1a1a",
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
