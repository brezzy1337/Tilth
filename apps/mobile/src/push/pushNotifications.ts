/**
 * pushNotifications — Expo push registration + notification deep links (F-037).
 *
 * `usePushNotifications(enabled)` is mounted once in RootNavigator and armed
 * when auth resolves to signedIn. It:
 *   1. Requests notification permission (non-blocking if denied), fetches the
 *      Expo push token, and registers it via `chat.registerPushToken`.
 *   2. Listens for notification taps and deep-links pushes carrying a
 *      `data.conversationId` into the Conversation screen (including the
 *      cold-start tap, via getLastNotificationResponseAsync).
 *
 * Every step is wrapped so a failure (simulator, denied permission, no
 * network, missing projectId) can never break app start — push is strictly
 * best-effort. `getExpoPushTokenAsync()` is called without an explicit
 * projectId: expo-notifications resolves it internally from the app config
 * (extra.eas.projectId via its own expo-constants dependency), which this
 * app sets in app.json.
 */

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { trpc } from "../api/trpc";
import { navigateToConversation } from "../navigation/rootNavigation";

// Show chat pushes as banners while the app is foregrounded (quiet: no sound
// or badge mutation — the inbox's unread badges are the source of truth).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Extract a conversation id from a notification's data payload, if present. */
function conversationIdFromResponse(
  response: Notifications.NotificationResponse | null,
): string | null {
  const raw = response?.notification.request.content.data?.["conversationId"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function usePushNotifications(enabled: boolean): void {
  const registerPushToken = trpc.chat.registerPushToken.useMutation();
  // Keep the latest mutation object in a ref so the effect doesn't re-run
  // (and re-register) every render.
  const registerRef = useRef(registerPushToken);
  registerRef.current = registerPushToken;

  // --- Token registration -------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function register() {
      try {
        // Push tokens only exist on physical devices.
        if (!Device.isDevice) return;
        if (Platform.OS !== "ios" && Platform.OS !== "android") return;

        if (Platform.OS === "android") {
          // A channel must exist before Android 8+ shows anything.
          await Notifications.setNotificationChannelAsync("default", {
            name: "Messages",
            importance: Notifications.AndroidImportance.DEFAULT,
          });
        }

        const current = await Notifications.getPermissionsAsync();
        let granted = current.granted;
        if (!granted && current.canAskAgain) {
          granted = (await Notifications.requestPermissionsAsync()).granted;
        }
        if (!granted) return; // Denied is fine — the app works without push.

        const { data: token } = await Notifications.getExpoPushTokenAsync();
        if (cancelled || !token) return;

        registerRef.current.mutate({ token, platform: Platform.OS });
      } catch (err) {
        // Best-effort only — log and move on, never surface to the user.
        console.warn(
          "[push] registration skipped:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    void register();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // --- Deep link: notification tap → Conversation screen ------------------
  useEffect(() => {
    if (!enabled) return;

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const conversationId = conversationIdFromResponse(response);
      if (conversationId) navigateToConversation(conversationId);
    });

    // Cold start: the tap that launched the app fires before any listener
    // exists, so pick it up explicitly once auth has resolved.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        const conversationId = conversationIdFromResponse(response);
        if (conversationId) navigateToConversation(conversationId);
      })
      .catch(() => {
        // Ignore — cold-start deep linking is best-effort.
      });

    return () => {
      subscription.remove();
    };
  }, [enabled]);
}
