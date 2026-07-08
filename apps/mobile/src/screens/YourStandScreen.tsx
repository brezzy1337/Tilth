/**
 * YourStandScreen — seller dashboard, "Harvest Warm" journey/dashboard rebuild (F-044).
 *
 * Three top-level views, chosen by store/setup state (see StoreView below):
 *   1. No store yet (`store === null`)                  → WelcomeCreateStore
 *   2. Store exists, setup incomplete                    → SetupJourneyView
 *   3. Store fully set up (chargesEnabled && listings>0) → DashboardView
 *
 * All underlying behaviour from the pre-rebuild screen is preserved:
 *   - Create-store flow: createStoreInput (name, logo?, about?)
 *   - Payments: Stripe Connect onboarding — connect.status.useQuery() +
 *     connect.createOnboardingLink.useMutation() → opens Stripe hosted
 *     onboarding via expo-web-browser → REFETCHES connect.status after the
 *     browser closes. The browser closing is NOT treated as success; the
 *     status booleans (driven by the account.updated webhook) are the only
 *     source of truth.
 *   - Location: setStoreLocationInput (address, city, state, zip) →
 *     geo.setStoreLocation.useMutation()
 *   - Listings: list existing + add-listing form (createListingInput: name,
 *     category, priceCents, quantity, unit). Price entered in dollars →
 *     converted to integer cents before submit. AddListingForm stays GATED
 *     behind chargesEnabled; existing listings always show.
 *
 * Step-2 (location) completion heuristic: the server has no "location saved"
 * query, so step 2 is tracked with local state after a successful save
 * *this session* (see `locationSavedThisSession` in StoreView). If the seller
 * already has a listing, they necessarily got through location setup in an
 * earlier session — so step 2 is also treated as complete whenever step 3
 * (listings) is complete, even without local state for the current session.
 *
 * Contracts from @homegrown/shared — never redeclared here.
 * No form library — useState + shared zod safeParse.
 * FormField reusable component for label + TextInput + inline error.
 * React Native only — no DOM elements.
 */

import React, { useEffect, useState } from "react";
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
import { Ionicons } from "@expo/vector-icons";
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
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { SectionHeader } from "../components/SectionHeader";
import type { AuthedNavigationProp } from "../navigation/types";
import { capitalise } from "../utils/text";
import { formatCents } from "../utils/money";
import { colors, radii, spacing, type } from "../theme";
import { categoryEmoji, unitLabel } from "../theme/categoryEmoji";

// ---------------------------------------------------------------------------
// Category and unit option arrays derived from the shared enums
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS: readonly ListingCategory[] = listingCategory.options;

const UNIT_OPTIONS: ListingUnit[] = ["each", "lb", "oz", "bunch", "dozen", "jar", "pint", "quart"];

// ---------------------------------------------------------------------------
// WelcomeCreateStore — state 1: no store yet
// ---------------------------------------------------------------------------

function WelcomeCreateStore({ onCreated }: { onCreated: () => void }) {
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
    <View>
      <SectionHeader
        emoji="🌱"
        title="Let's open your stand"
        subtitle="Tell your neighbors what you grow — you can add payments and produce next."
        tint={colors.secondarySoft}
        iconColor={colors.secondary}
        size="title"
      />

      <Card style={styles.formCard}>
        <FormField
          label="Stand name"
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

        <Button title="Create my stand" onPress={handleSubmit} loading={mutation.isPending} />
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------
// PaymentsSectionBody — Stripe Connect onboarding content for step 1.
// Rendered inside a StepRow (journey) — no section title of its own.
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

function PaymentsSectionBody() {
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
    <View>
      {/* Loading state */}
      {isLoading && <ActivityIndicator size="small" color={colors.secondary} style={styles.loader} />}

      {/* Error loading status */}
      {error && !isLoading ? (
        <View>
          <Text style={styles.serverError}>Could not load payment status: {error.message}</Text>
          <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetch()} />
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
            <Button
              title="View earnings & payouts"
              variant="secondary"
              onPress={() => dashboardLinkMutation.mutate()}
              loading={dashboardLinkMutation.isPending}
            />
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
          <Button title="Continue setup" onPress={handleSetupPress} loading={isPending} />
          <Button
            title="Refresh status"
            variant="ghost"
            onPress={() => void refetch()}
            disabled={isLoading}
          />
        </View>
      ) : null}

      {/* State: Not started — no details submitted yet */}
      {status && !status.detailsSubmitted ? (
        <View>
          <Text style={styles.sectionSubtitle}>
            Connect a payout account with Stripe to start selling.
          </Text>
          <Button title="Set up payments" onPress={handleSetupPress} loading={isPending} />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// LocationSectionBody — address form content for step 2 (and the Dashboard's
// "Stand settings" disclosure). Calls `onSaved` with a one-line address
// summary on success so callers can track this-session completion.
// ---------------------------------------------------------------------------

function LocationSectionBody({ onSaved }: { onSaved: (summary: string) => void }) {
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
      const summary = `${data.address}, ${data.city}, ${data.state} ${data.zip}`;
      setSavedAddress(summary);
      setServerError(null);
      onSaved(summary);
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
    <View>
      {savedAddress ? (
        <View style={styles.successCard}>
          <Text style={styles.successText}>Location saved: {savedAddress}</Text>
        </View>
      ) : null}

      <FormField
        label="Street address"
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
        label="ZIP code"
        value={zip}
        onChangeText={setZip}
        error={errors.zip}
        placeholder="90210"
        keyboardType="number-pad"
        maxLength={12}
      />

      {serverError ? <Text style={styles.serverError}>{serverError}</Text> : null}

      <Button title="Save location" onPress={handleSubmit} loading={mutation.isPending} />
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
    <View style={styles.addListingForm}>
      <Text style={styles.cardLabel}>Add a listing</Text>

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
                {categoryEmoji(opt)} {capitalise(opt)}
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

      <Button title="Add listing" onPress={handleSubmit} loading={mutation.isPending} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// ListingsStepBody — step 3 content: existing listings (usually none yet) +
// AddListingForm, gated behind chargesEnabled exactly as before.
// ---------------------------------------------------------------------------

function ListingsStepBody({
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
    <View>
      {isLoading && <ActivityIndicator size="small" color={colors.secondary} style={styles.loader} />}

      {error ? (
        <View>
          <Text style={styles.serverError}>Could not load listings: {error.message}</Text>
          <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetch()} />
        </View>
      ) : null}

      {listings && listings.length === 0 ? (
        <Text style={styles.emptyText}>No listings yet — add your first below.</Text>
      ) : null}

      {listings && listings.length > 0
        ? listings.map((item) => (
            <View key={item.id} style={styles.listingCard}>
              <Text style={styles.listingName}>
                {categoryEmoji(item.category)} {item.name}
              </Text>
              <Text style={styles.listingMeta}>
                ${formatCents(item.priceCents)}/{item.unit} · {item.quantity}{" "}
                {unitLabel(item.quantity, item.unit)}
              </Text>
            </View>
          ))
        : null}

      {/* Gate AddListingForm behind chargesEnabled. Show a notice when not enabled. */}
      {chargesEnabled ? (
        <AddListingForm onAdded={handleListingAdded} />
      ) : (
        <View style={styles.gateCard}>
          <Text style={styles.gateCardText}>Set up payments first, then add your first listing here.</Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// StepRow — one row of the setup journey checklist. Completed steps collapse
// to a one-line summary with a green check; the expanded step is
// terracotta-highlighted and shows its full content.
// ---------------------------------------------------------------------------

function StepRow({
  number,
  emoji,
  title,
  complete,
  expanded,
  onPress,
  summary,
  children,
}: {
  number: 1 | 2 | 3;
  emoji: string;
  title: string;
  complete: boolean;
  expanded: boolean;
  onPress: () => void;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      variant={expanded ? "surface" : "tint"}
      style={[styles.stepCard, expanded ? styles.stepCardActive : null]}
    >
      <Pressable style={styles.stepHeader} onPress={onPress}>
        <View
          style={[
            styles.stepBadge,
            complete ? styles.stepBadgeComplete : expanded ? styles.stepBadgeActive : null,
          ]}
        >
          {complete ? (
            <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
          ) : (
            <Text style={styles.stepEmoji}>{emoji}</Text>
          )}
        </View>
        <View style={styles.stepTextCol}>
          <Text style={[styles.stepTitle, expanded ? styles.stepTitleActive : null]}>
            {number}. {title}
          </Text>
          {!expanded && summary ? <Text style={styles.stepSummary}>{summary}</Text> : null}
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color={colors.textMuted}
        />
      </Pressable>
      {expanded ? <View style={styles.stepBody}>{children}</View> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SetupJourneyView — state 2: store exists but setup isn't finished.
// See the file-level doc comment for the step-2 (location) heuristic.
// ---------------------------------------------------------------------------

function SetupJourneyView({
  storeId,
  storeName,
  chargesEnabled,
  hasListings,
  locationComplete,
  locationSummary,
  onLocationSaved,
}: {
  storeId: string;
  storeName: string;
  chargesEnabled: boolean;
  hasListings: boolean;
  locationComplete: boolean;
  locationSummary: string | null;
  onLocationSaved: (summary: string) => void;
}) {
  const steps: { number: 1 | 2 | 3; complete: boolean }[] = [
    { number: 1, complete: chargesEnabled },
    { number: 2, complete: locationComplete },
    { number: 3, complete: hasListings },
  ];
  const firstIncompleteStep = steps.find((s) => !s.complete)?.number ?? 3;

  // The expanded/highlighted step auto-advances whenever real progress is made
  // (a step's completion flag changes), but otherwise stays put — so tapping
  // around to review a different (e.g. already-complete) step isn't fought by
  // this effect on every render.
  const [expandedStep, setExpandedStep] = useState<1 | 2 | 3>(firstIncompleteStep);
  useEffect(() => {
    setExpandedStep(firstIncompleteStep);
  }, [firstIncompleteStep]);

  return (
    <View>
      <SectionHeader emoji="🌻" title={storeName} tint={colors.accentSoft} iconColor={colors.accent} size="title" />
      <Text style={styles.headlineSubtitle}>Let's get your stand ready to sell.</Text>

      <View style={styles.progressRow}>
        {steps.map((s) => (
          <View
            key={s.number}
            style={[
              styles.progressDot,
              s.complete ? styles.progressDotComplete : null,
              !s.complete && s.number === expandedStep ? styles.progressDotActive : null,
            ]}
          />
        ))}
      </View>

      <StepRow
        number={1}
        emoji="💰"
        title="Payments"
        complete={chargesEnabled}
        expanded={expandedStep === 1}
        onPress={() => setExpandedStep(1)}
        summary={chargesEnabled ? "Ready to accept orders" : undefined}
      >
        <PaymentsSectionBody />
      </StepRow>

      <StepRow
        number={2}
        emoji="📍"
        title="Location"
        complete={locationComplete}
        expanded={expandedStep === 2}
        onPress={() => setExpandedStep(2)}
        summary={locationSummary ?? (locationComplete ? "Saved" : undefined)}
      >
        <LocationSectionBody onSaved={onLocationSaved} />
      </StepRow>

      <StepRow
        number={3}
        emoji="🧺"
        title="First listing"
        complete={hasListings}
        expanded={expandedStep === 3}
        onPress={() => setExpandedStep(3)}
        summary={hasListings ? "Listed" : undefined}
      >
        <ListingsStepBody storeId={storeId} chargesEnabled={chargesEnabled} />
      </StepRow>
    </View>
  );
}

// ---------------------------------------------------------------------------
// DashboardView — state 3: store fully set up (chargesEnabled && listings>0).
// Listings are front-and-center; payments status and location settle into a
// compact status row and a tucked-away disclosure, respectively.
// ---------------------------------------------------------------------------

function DashboardView({ storeId, storeName }: { storeId: string; storeName: string }) {
  const navigation = useNavigation<AuthedNavigationProp>();
  const utils = trpc.useUtils();

  const { data: connectStatusData } = trpc.connect.status.useQuery();

  const {
    data: listings,
    isLoading: listingsLoading,
    error: listingsError,
    refetch: refetchListings,
  } = trpc.listings.listByStore.useQuery({ storeId });

  const dashboardLinkMutation = trpc.connect.dashboardLink.useMutation({
    onSuccess: async (data) => {
      await WebBrowser.openBrowserAsync(data.url);
    },
    onError: (err) => {
      Alert.alert("Could not open dashboard", err.message ?? "Please try again.");
    },
  });

  const [addFormOpen, setAddFormOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function handleListingAdded() {
    setAddFormOpen(false);
    void utils.listings.listByStore.invalidate({ storeId });
  }

  return (
    <View>
      <View style={styles.storeHeader}>
        <SectionHeader emoji="🌻" title={storeName} tint={colors.accentSoft} iconColor={colors.accent} size="title" />
      </View>

      {/* Compact payments status row — tap to open the Stripe Express dashboard */}
      <Pressable
        style={styles.statusRow}
        onPress={() => dashboardLinkMutation.mutate()}
        disabled={dashboardLinkMutation.isPending}
      >
        <Text style={styles.statusRowText}>
          {"💰"} Payments <Text style={styles.statusCheck}>{"✓"}</Text>
          {connectStatusData?.payoutsEnabled ? " · Payouts enabled" : ""}
        </Text>
        {dashboardLinkMutation.isPending ? (
          <ActivityIndicator size="small" color={colors.secondary} />
        ) : (
          <Text style={styles.statusRowLink}>View earnings ›</Text>
        )}
      </Pressable>

      {/* Listings — front and center */}
      <View style={styles.dashboardSection}>
        <SectionHeader
          emoji="🧺"
          title="Your listings"
          subtitle={`${listings?.length ?? 0} live`}
        />

        {listingsLoading && (
          <ActivityIndicator size="small" color={colors.secondary} style={styles.loader} />
        )}

        {listingsError ? (
          <View>
            <Text style={styles.serverError}>Could not load listings: {listingsError.message}</Text>
            <Button
              title="Retry"
              variant="ghost"
              fullWidth={false}
              onPress={() => void refetchListings()}
            />
          </View>
        ) : null}

        {listings?.map((item) => (
          <Card key={item.id} variant="tint" flat style={styles.listingRow}>
            <View style={styles.listingRowInner}>
              <Text style={styles.listingRowEmoji}>{categoryEmoji(item.category)}</Text>
              <View style={styles.listingRowInfo}>
                <Text style={styles.listingName}>{item.name}</Text>
                <Text style={styles.listingMeta}>
                  ${formatCents(item.priceCents)}/{item.unit} · {item.quantity}{" "}
                  {unitLabel(item.quantity, item.unit)}
                </Text>
              </View>
            </View>
          </Card>
        ))}

        <Button
          title={addFormOpen ? "Close" : "+ Add produce"}
          variant={addFormOpen ? "secondary" : "primary"}
          onPress={() => setAddFormOpen((open) => !open)}
          style={styles.addProduceButton}
        />
        {addFormOpen ? <AddListingForm onAdded={handleListingAdded} /> : null}
      </View>

      <Button
        title="📦 Orders / refund requests"
        variant="secondary"
        onPress={() => navigation.navigate("StoreOrders")}
        style={styles.ordersButton}
      />

      {/* Stand settings — location editor tucked away */}
      <Pressable style={styles.disclosureRow} onPress={() => setSettingsOpen((open) => !open)}>
        <Text style={styles.disclosureText}>{"⚙️"} Stand settings</Text>
        <Ionicons
          name={settingsOpen ? "chevron-up" : "chevron-down"}
          size={18}
          color={colors.textMuted}
        />
      </Pressable>
      {settingsOpen ? (
        <Card variant="tint" style={styles.settingsCard}>
          <LocationSectionBody onSaved={() => {}} />
        </Card>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// StoreView — shown once a store exists. Decides journey vs dashboard.
// ---------------------------------------------------------------------------

function StoreView({ storeId, storeName }: { storeId: string; storeName: string }) {
  const { data: connectStatusData, isLoading: connectLoading } = trpc.connect.status.useQuery();
  const { data: listings, isLoading: listingsLoading } = trpc.listings.listByStore.useQuery({
    storeId,
  });

  const chargesEnabled = connectStatusData?.chargesEnabled ?? false;
  const hasListings = (listings?.length ?? 0) > 0;

  // See file-level doc comment: step 2 (location) has no server-side "is it
  // saved" query, so it's tracked locally after a successful save this
  // session, OR treated as complete once step 3 (listings) is complete.
  const [locationSavedThisSession, setLocationSavedThisSession] = useState<string | null>(null);
  const locationComplete = locationSavedThisSession !== null || hasListings;

  const isInitialLoading = connectLoading || listingsLoading;
  const setupComplete = chargesEnabled && hasListings;

  if (isInitialLoading) {
    return <ActivityIndicator size="large" color={colors.secondary} style={styles.loader} />;
  }

  if (setupComplete) {
    return <DashboardView storeId={storeId} storeName={storeName} />;
  }

  return (
    <SetupJourneyView
      storeId={storeId}
      storeName={storeName}
      chargesEnabled={chargesEnabled}
      hasListings={hasListings}
      locationComplete={locationComplete}
      locationSummary={locationSavedThisSession}
      onLocationSaved={setLocationSavedThisSession}
    />
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
          {isLoading && <ActivityIndicator size="large" color={colors.secondary} style={styles.loader} />}

          {error ? (
            <View>
              <Text style={styles.serverError}>Could not load store: {error.message}</Text>
              <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetch()} />
            </View>
          ) : null}

          {!isLoading && !error && store === null ? (
            <WelcomeCreateStore onCreated={handleStoreCreated} />
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
    backgroundColor: colors.bg,
  },
  container: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl * 1.5,
  },
  loader: {
    marginTop: spacing.xxxl,
  },
  formCard: {
    marginTop: spacing.xl,
  },
  headlineSubtitle: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  sectionSubtitle: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },

  // Progress dots
  progressRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  progressDot: {
    flex: 1,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.border,
  },
  progressDotComplete: {
    backgroundColor: colors.secondary,
  },
  progressDotActive: {
    backgroundColor: colors.primary,
  },

  // Step rows
  stepCard: {
    marginBottom: spacing.md,
    padding: 0,
    overflow: "hidden",
  },
  stepCardActive: {
    borderWidth: 1,
    borderColor: colors.primary,
  },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  stepBadge: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBadgeActive: {
    backgroundColor: colors.primarySoft,
  },
  stepBadgeComplete: {
    backgroundColor: colors.secondary,
  },
  stepEmoji: {
    fontSize: 16,
  },
  stepTextCol: {
    flex: 1,
  },
  stepTitle: {
    fontSize: type.body.fontSize,
    fontWeight: "600",
    color: colors.text,
  },
  stepTitleActive: {
    color: colors.primary,
  },
  stepSummary: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginTop: 2,
  },
  stepBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },

  // Store header (journey + dashboard)
  storeHeader: {
    marginBottom: spacing.lg,
  },

  // Dashboard
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.secondarySoft,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xl,
  },
  statusRowText: {
    fontSize: type.body.fontSize,
    fontWeight: "600",
    color: colors.text,
  },
  statusCheck: {
    color: colors.secondary,
    fontWeight: "700",
  },
  statusRowLink: {
    fontSize: type.caption.fontSize,
    fontWeight: "700",
    color: colors.secondary,
  },
  dashboardSection: {
    marginBottom: spacing.xxl,
    gap: spacing.md,
  },
  listingRow: {
    marginTop: spacing.sm,
  },
  listingRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  listingRowEmoji: {
    fontSize: 22,
  },
  listingRowInfo: {
    flex: 1,
  },
  addProduceButton: {
    marginTop: spacing.md,
  },
  ordersButton: {
    marginBottom: spacing.xl,
  },
  disclosureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  disclosureText: {
    fontSize: type.body.fontSize,
    fontWeight: "600",
    color: colors.textMuted,
  },
  settingsCard: {
    marginTop: spacing.md,
  },

  // Shared cards/notices
  successCard: {
    backgroundColor: colors.secondarySoft,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  successText: {
    fontSize: type.caption.fontSize,
    color: colors.secondary,
    fontWeight: "500",
  },
  infoCard: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  infoCardTitle: {
    fontSize: type.body.fontSize,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.xs,
  },
  gateCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
    padding: spacing.lg,
    marginTop: spacing.md,
    alignItems: "center",
  },
  gateCardText: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    textAlign: "center",
  },
  emptyText: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  listingCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  listingName: {
    fontSize: type.body.fontSize,
    fontWeight: "600",
    color: colors.text,
    marginBottom: 2,
  },
  listingMeta: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
  addListingForm: {
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  cardLabel: {
    fontSize: type.label.fontSize,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.lg,
  },
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  pickerLabel: {
    fontSize: type.label.fontSize,
    fontWeight: type.label.fontWeight,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: type.caption.fontSize,
    color: colors.text,
  },
  chipTextActive: {
    color: colors.onPrimary,
    fontWeight: "700",
  },
  fieldError: {
    marginTop: spacing.xs,
    fontSize: 12,
    color: colors.danger,
  },
  serverError: {
    marginBottom: spacing.md,
    fontSize: type.caption.fontSize,
    color: colors.danger,
    textAlign: "center",
  },
  multilineInput: {
    minHeight: 80,
    textAlignVertical: "top",
  },
});
