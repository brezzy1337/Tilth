/**
 * SettingsScreen — account settings home (F-051).
 *
 * Replaces HomeScreen's former header sign-out icon as the account-controls
 * entry point (a gear icon now pushes here instead); sign-out itself moved
 * into this screen's Account section, unchanged (same `useAuth().signOut`
 * call the header used).
 *
 * Sectioned list of rows (SectionHeader + Card, MessagesScreen/ListingCard
 * row conventions — surface card, pressed-state tint, chevron for
 * navigational rows):
 *   - Account: username/email (read-only), change password, sign out.
 *   - Notifications: push master toggle (persisted — see
 *     `../push/pushPreference`) + "Open system settings".
 *   - Privacy: blocked users (with a count badge).
 *   - Selling & buying: contextual — only rendered when the caller owns a
 *     store (`stores.getMine`) and/or represents a linked community place
 *     (`places.mine`), same two "am I a seller / place buyer" queries
 *     HomeScreen already runs.
 *   - About: ToS/privacy links, support contact, app version, OSM credit.
 *   - Danger zone: delete account (tomato/pop — theme's danger convention).
 *
 * React Native only — no DOM elements.
 */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { Card } from "../components/Card";
import { ColorBadge } from "../components/ColorBadge";
import { SectionHeader } from "../components/SectionHeader";
import { getDeviceExpoPushToken } from "../push/pushNotifications";
import { getPushPreference, setPushPreference } from "../push/pushPreference";
import { SUPPORT_EMAIL, OSM_ATTRIBUTION } from "../constants/legal";
import type { AuthedNavigationProp } from "../navigation/types";
import { colors, spacing, type } from "../theme";
// app.json is the single source of truth for the app version shown in About
// (no expo-constants dependency — it isn't a direct dep of this package).
import appConfig from "../../app.json";

// ---------------------------------------------------------------------------
// SettingsRow — a single tappable (or static) row inside a Card, matching
// MessagesScreen's row conventions (pressed-state tint) at a smaller,
// single-line grain.
// ---------------------------------------------------------------------------

type RowProps = {
  label: string;
  value?: string;
  onPress?: () => void;
  labelColor?: string;
  right?: React.ReactNode;
  disabled?: boolean;
};

function SettingsRow({ label, value, onPress, labelColor, right, disabled }: RowProps) {
  const interactive = !!onPress && !disabled;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && interactive ? styles.rowPressed : null]}
      onPress={interactive ? onPress : undefined}
      accessibilityRole={interactive ? "button" : undefined}
      disabled={!interactive}
    >
      <Text style={[styles.rowLabel, labelColor ? { color: labelColor } : null]}>{label}</Text>
      <View style={styles.rowRight}>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        {right}
        {onPress && !right ? (
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        ) : null}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// SettingsScreen
// ---------------------------------------------------------------------------

export function SettingsScreen() {
  const navigation = useNavigation<AuthedNavigationProp>();
  const { user, signOut } = useAuth();

  const { data: myStore } = trpc.stores.getMine.useQuery();
  const { data: myPlace } = trpc.places.mine.useQuery();
  const { data: blocked } = trpc.chat.listBlocked.useQuery();

  // --- Push master toggle ---------------------------------------------------
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null); // null = loading
  const [pushBusy, setPushBusy] = useState(false);
  const registerPushToken = trpc.chat.registerPushToken.useMutation();
  const unregisterPushToken = trpc.chat.unregisterPushToken.useMutation();

  useEffect(() => {
    let cancelled = false;
    void getPushPreference().then((value) => {
      if (!cancelled) setPushEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTogglePush(next: boolean) {
    // The toggle is only rendered once `pushEnabled` has loaded, so this is
    // always a real value here — captured up front so both branches below
    // can revert to it on failure.
    const previous = pushEnabled;
    if (previous === null) return;

    setPushBusy(true);
    try {
      await setPushPreference(next);
      setPushEnabled(next);

      if (next) {
        const token = await getDeviceExpoPushToken();
        if (!token) {
          Alert.alert(
            "Notifications are off",
            "Enable notifications for Tilth in your device Settings to receive them.",
          );
          return;
        }
        try {
          await registerPushToken.mutateAsync({
            token,
            platform: Platform.OS as "ios" | "android",
          });
        } catch (err) {
          // Registration failed server-side — revert the local flag and the
          // toggle so we don't show "on" while the server never learned
          // about this device. Mirrors the OFF-direction revert below.
          await setPushPreference(previous);
          setPushEnabled(previous);
          Alert.alert(
            "Could not turn on notifications",
            err instanceof Error ? err.message : "Please try again.",
          );
        }
      } else {
        // Only fetch the token if permission was already granted — no reason
        // to trigger a permission prompt just to turn something off.
        const token = await getDeviceExpoPushToken({ requestPermission: false });
        if (!token) return;
        try {
          await unregisterPushToken.mutateAsync({ token });
        } catch (err) {
          // Unregistration failed — the server still holds this token and
          // will keep pushing, so leaving the toggle showing OFF would be a
          // silent lie about the account's notification state. Revert
          // (mirrors the ON-direction revert above); `usePushNotifications`
          // also self-heals this on next launch if the user just quits here.
          await setPushPreference(previous);
          setPushEnabled(previous);
          Alert.alert(
            "Could not turn off notifications",
            err instanceof Error ? err.message : "Please try again.",
          );
        }
      }
    } finally {
      setPushBusy(false);
    }
  }

  // --- Selling & buying: earnings dashboard link (mirrors YourStandScreen's
  // compact status row — mutate() directly, open the returned URL, surface
  // any precondition/error via Alert) -------------------------------------

  const dashboardLinkMutation = trpc.connect.dashboardLink.useMutation({
    onSuccess: async (data) => {
      await WebBrowser.openBrowserAsync(data.url);
    },
    onError: (err) => {
      Alert.alert("Could not open dashboard", err.message ?? "Please try again.");
    },
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Account */}
        <SectionHeader icon="person-circle-outline" title="Account" />
        <Card style={styles.sectionCard} flat>
          <SettingsRow label="Username" value={user?.username ?? ""} />
          <View style={styles.divider} />
          <SettingsRow label="Email" value={user?.email ?? ""} />
          <View style={styles.divider} />
          <SettingsRow
            label="Change password"
            onPress={() => navigation.navigate("ChangePassword")}
          />
          <View style={styles.divider} />
          <SettingsRow label="Sign out" onPress={() => void signOut()} />
        </Card>

        {/* Notifications */}
        <SectionHeader icon="notifications-outline" title="Notifications" />
        <Card style={styles.sectionCard} flat>
          <SettingsRow
            label="Push notifications"
            disabled={pushEnabled === null || pushBusy}
            right={
              pushEnabled === null ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Switch
                  value={pushEnabled}
                  onValueChange={(next) => void handleTogglePush(next)}
                  disabled={pushBusy}
                  trackColor={{ true: colors.primary, false: colors.border }}
                  // First themed Switch in the app — sets the token
                  // precedent. Both states resolve to white in this palette
                  // (`onPrimary` === `surface` === #FFFFFF), matching the
                  // platform-standard white-thumb look, but each is the
                  // semantically correct token for its state: `onPrimary`
                  // (text-on-solid-color) against the solid `colors.primary`
                  // track when on, `surface` (base surface) against the pale
                  // `colors.border` track when off — either reads with
                  // plenty of contrast against its track.
                  thumbColor={pushEnabled ? colors.onPrimary : colors.surface}
                />
              )
            }
          />
          <View style={styles.divider} />
          <SettingsRow label="Open system settings" onPress={() => void Linking.openSettings()} />
        </Card>

        {/* Privacy */}
        <SectionHeader icon="lock-closed-outline" title="Privacy" />
        <Card style={styles.sectionCard} flat>
          <SettingsRow
            label="Blocked users"
            onPress={() => navigation.navigate("BlockedUsers")}
            right={
              blocked && blocked.length > 0 ? (
                <ColorBadge
                  label={String(blocked.length)}
                  bg={colors.surfaceAlt}
                  text={colors.textMuted}
                />
              ) : undefined
            }
          />
        </Card>

        {/* Selling & buying — contextual */}
        {myStore || myPlace ? (
          <>
            <SectionHeader icon="storefront-outline" title="Selling & buying" />
            <Card style={styles.sectionCard} flat>
              {myStore ? (
                <SettingsRow
                  label="Earnings & payouts"
                  onPress={() => dashboardLinkMutation.mutate()}
                  right={
                    dashboardLinkMutation.isPending ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : undefined
                  }
                />
              ) : null}
              {myStore && myPlace ? <View style={styles.divider} /> : null}
              {myPlace ? <SettingsRow label={`You represent \u{1F9FA} ${myPlace.name}`} /> : null}
            </Card>
          </>
        ) : null}

        {/* About */}
        <SectionHeader icon="information-circle-outline" title="About" />
        <Card style={styles.sectionCard} flat>
          <SettingsRow
            label="Terms of Service"
            onPress={() => navigation.navigate("Legal", { doc: "terms" })}
          />
          <View style={styles.divider} />
          <SettingsRow
            label="Privacy Policy"
            onPress={() => navigation.navigate("Legal", { doc: "privacy" })}
          />
          <View style={styles.divider} />
          <SettingsRow
            label="Contact support"
            onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
          />
          <View style={styles.divider} />
          <SettingsRow label="App version" value={appConfig.expo.version} />
          <View style={styles.divider} />
          <Text style={styles.attribution}>{OSM_ATTRIBUTION}</Text>
        </Card>

        {/* Danger zone */}
        <SectionHeader
          icon="warning-outline"
          title="Danger zone"
          tint={colors.popSoft}
          iconColor={colors.pop}
        />
        <Card style={styles.sectionCard} flat>
          <SettingsRow
            label="Delete account"
            labelColor={colors.pop}
            onPress={() => navigation.navigate("DeleteAccount")}
          />
        </Card>
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
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl,
    gap: spacing.sm,
  },
  sectionCard: {
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    paddingVertical: spacing.xs,
    paddingHorizontal: 0,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    minHeight: 48,
  },
  rowPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  rowLabel: {
    fontSize: type.body.fontSize,
    color: colors.text,
    flexShrink: 1,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  rowValue: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.lg,
  },
  attribution: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
