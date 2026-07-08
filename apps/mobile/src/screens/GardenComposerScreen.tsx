/**
 * GardenComposerScreen — seller flow to publish a garden post (F-047).
 *
 * Pushed (modal presentation) from GardenFeedScreen's "+" FAB, which is only
 * shown to users who have a store. Two independent actions, sharing one
 * caption field (<=500 chars, shared caption input from
 * createGardenPostPhotoSetInput/createGardenPostVideoInput):
 *
 *   Photos — expo-image-picker (library, multi-select <=10, quality 0.8) →
 *     garden.createPhotoUploadUrls (grouped by contentType so mixed
 *     jpeg/png/webp selections still work) → PUT each asset to its signed
 *     GCS uploadUrl via expo-file-system's legacy uploadAsync → garden.
 *     createPhotoSet with the returned publicUrls → invalidate the feed →
 *     dismiss.
 *
 *   Video — expo-image-picker (library, videos, <=60s) → garden.createVideo
 *     (creates the post as "processing" + a Mux direct-upload URL) → PUT the
 *     raw file to that Mux uploadUrl via expo-file-system → show a
 *     processing notice (the post won't appear in the feed until the Mux
 *     webhook flips it to "ready") → dismiss.
 *
 * PRECONDITION_FAILED from either createPhotoUploadUrls or createVideo means
 * the server's GCS/Mux credentials aren't configured yet (expected for the
 * pilot on day one) — shown as a friendly "uploads aren't enabled yet"
 * notice rather than a raw error.
 *
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { GardenPostPhoto } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import type { AuthedStackParamList } from "../navigation/types";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { colors, radii, spacing, type } from "../theme";

type Props = NativeStackScreenProps<AuthedStackParamList, "GardenComposer">;

const CAPTION_MAX = 500;

type AllowedContentType = "image/jpeg" | "image/png" | "image/webp";

function normalizeContentType(mimeType: string | null | undefined): AllowedContentType {
  if (mimeType === "image/png") return "image/png";
  if (mimeType === "image/webp") return "image/webp";
  return "image/jpeg";
}

/** Friendly message for the server's PRECONDITION_FAILED (media not configured yet). */
function describeError(err: { data?: { code?: string } | null; message?: string }): string {
  if (err.data?.code === "PRECONDITION_FAILED") {
    return "Uploads aren't enabled yet on this server. Check back soon.";
  }
  return err.message ?? "Something went wrong. Please try again.";
}

export function GardenComposerScreen({ navigation }: Props) {
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [processingNotice, setProcessingNotice] = useState(false);

  const utils = trpc.useUtils();
  const createPhotoUploadUrls = trpc.garden.createPhotoUploadUrls.useMutation();
  const createPhotoSet = trpc.garden.createPhotoSet.useMutation();
  const createVideo = trpc.garden.createVideo.useMutation();

  function handleDone() {
    void utils.garden.feed.invalidate();
    navigation.goBack();
  }

  async function handlePickPhotos() {
    setErrorMessage(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setErrorMessage("Photo library access is required to post photos.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.8,
    });

    if (result.canceled || result.assets.length === 0) {
      return;
    }

    const assets = result.assets;
    setBusy(true);

    try {
      // Group by contentType (preserving original order) so a mixed
      // jpeg/png/webp selection still round-trips through
      // createPhotoUploadUrls, which only accepts one contentType per call.
      const groups = new Map<AllowedContentType, number[]>();
      assets.forEach((asset, index) => {
        const contentType = normalizeContentType(asset.mimeType);
        const indices = groups.get(contentType) ?? [];
        indices.push(index);
        groups.set(contentType, indices);
      });

      const photos: (GardenPostPhoto | undefined)[] = new Array(assets.length);

      for (const [contentType, indices] of groups) {
        const urls = await createPhotoUploadUrls.mutateAsync({
          count: indices.length,
          contentType,
        });

        for (let i = 0; i < indices.length; i++) {
          const assetIndex = indices[i]!;
          const asset = assets[assetIndex]!;
          const { uploadUrl, publicUrl } = urls[i]!;

          await FileSystem.uploadAsync(uploadUrl, asset.uri, {
            httpMethod: "PUT",
            headers: { "Content-Type": contentType },
          });

          photos[assetIndex] = {
            url: publicUrl,
            width: asset.width > 0 ? asset.width : undefined,
            height: asset.height > 0 ? asset.height : undefined,
          };
        }
      }

      await createPhotoSet.mutateAsync({
        caption,
        photos: photos.filter((p): p is GardenPostPhoto => p !== undefined),
      });

      handleDone();
    } catch (err) {
      setErrorMessage(
        describeError(err as { data?: { code?: string } | null; message?: string }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handlePickVideo() {
    setErrorMessage(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setErrorMessage("Photo library access is required to post a video.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      videoMaxDuration: 60,
      quality: 0.8,
    });

    if (result.canceled || result.assets.length === 0) {
      return;
    }

    const asset = result.assets[0]!;

    // videoMaxDuration only bounds camera recording — library picks can be any
    // length, so enforce the 60s contract here before touching the server.
    if (asset.duration != null && asset.duration / 1000 > 60) {
      setErrorMessage("Please choose a video under 60 seconds.");
      return;
    }

    setBusy(true);

    try {
      const { uploadUrl } = await createVideo.mutateAsync({
        caption,
        durationS: asset.duration ? asset.duration / 1000 : undefined,
      });

      await FileSystem.uploadAsync(uploadUrl, asset.uri, {
        httpMethod: "PUT",
      });

      setProcessingNotice(true);
    } catch (err) {
      setErrorMessage(
        describeError(err as { data?: { code?: string } | null; message?: string }),
      );
    } finally {
      setBusy(false);
    }
  }

  if (processingNotice) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Card variant="tint" style={styles.processingCard}>
            <Text style={styles.processingEmoji}>{"\u{1F331}"}</Text>
            <Text style={styles.stateText}>Your video is growing…</Text>
            <Text style={styles.stateSubText}>
              It'll appear in the garden feed shortly, once it finishes encoding.
            </Text>
          </Card>
          <Button title="Done" onPress={handleDone} style={styles.doneButton} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Text style={styles.pageTitle}>{"\u{1F33F}"} Share what's growing</Text>
          <Text style={styles.pageSubtitle}>
            Post a photo set or a short video (up to 60s) for buyers nearby.
          </Text>

          <Card style={styles.formCard}>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Caption</Text>
              <TextInput
                style={styles.captionInput}
                value={caption}
                onChangeText={(text) => setCaption(text.slice(0, CAPTION_MAX))}
                placeholder="Fresh heirloom tomatoes just picked…"
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={3}
              />
              <Text style={styles.captionCount}>
                {caption.length}/{CAPTION_MAX}
              </Text>
            </View>

            {errorMessage ? <Text style={styles.serverError}>{errorMessage}</Text> : null}

            <Button
              title="Choose Photos"
              onPress={() => void handlePickPhotos()}
              loading={busy}
              disabled={busy}
            />

            <Button
              title="Choose Video"
              variant="secondary"
              onPress={() => void handlePickVideo()}
              loading={busy}
              disabled={busy}
              style={styles.secondaryButtonSpacing}
            />
          </Card>

          <Pressable
            style={styles.cancelButton}
            onPress={() => navigation.goBack()}
            disabled={busy}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </Pressable>
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
  pageTitle: {
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  pageSubtitle: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.xl,
  },
  formCard: {
    marginBottom: spacing.lg,
  },
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: type.label.fontSize,
    fontWeight: type.label.fontWeight,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  captionInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: type.body.fontSize,
    color: colors.text,
    backgroundColor: colors.surface,
    minHeight: 80,
    textAlignVertical: "top",
  },
  captionCount: {
    marginTop: spacing.xs,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "right",
  },
  serverError: {
    marginBottom: spacing.md,
    fontSize: type.caption.fontSize,
    color: colors.danger,
    textAlign: "center",
  },
  secondaryButtonSpacing: {
    marginTop: spacing.md,
  },
  cancelButton: {
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.md,
  },
  cancelButtonText: {
    color: colors.textMuted,
    fontSize: type.caption.fontSize + 1,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    gap: spacing.lg,
  },
  processingCard: {
    alignItems: "center",
  },
  processingEmoji: {
    fontSize: 36,
    marginBottom: spacing.sm,
  },
  doneButton: {
    alignSelf: "stretch",
  },
  stateText: {
    fontSize: type.section.fontSize,
    color: colors.text,
    textAlign: "center",
    fontWeight: "700",
  },
  stateSubText: {
    fontSize: type.caption.fontSize + 1,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: spacing.xs,
  },
});
