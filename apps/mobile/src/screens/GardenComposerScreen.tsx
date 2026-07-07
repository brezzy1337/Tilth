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
  ActivityIndicator,
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
          <Text style={styles.stateText}>Your video is processing</Text>
          <Text style={styles.stateSubText}>
            It'll appear in the garden feed shortly, once it finishes encoding.
          </Text>
          <Pressable style={styles.button} onPress={handleDone}>
            <Text style={styles.buttonText}>Done</Text>
          </Pressable>
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
          <Text style={styles.pageTitle}>Share what's growing</Text>
          <Text style={styles.pageSubtitle}>
            Post a photo set or a short video (up to 60s) for buyers nearby.
          </Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Caption</Text>
            <TextInput
              style={styles.captionInput}
              value={caption}
              onChangeText={(text) => setCaption(text.slice(0, CAPTION_MAX))}
              placeholder="Fresh heirloom tomatoes just picked…"
              placeholderTextColor="#aaa"
              multiline
              numberOfLines={3}
            />
            <Text style={styles.captionCount}>
              {caption.length}/{CAPTION_MAX}
            </Text>
          </View>

          {errorMessage ? <Text style={styles.serverError}>{errorMessage}</Text> : null}

          <Pressable
            style={[styles.button, busy ? styles.buttonDisabled : null]}
            onPress={() => void handlePickPhotos()}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Choose Photos</Text>
            )}
          </Pressable>

          <Pressable
            style={[styles.secondaryButton, busy ? styles.buttonDisabled : null]}
            onPress={() => void handlePickVideo()}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#2d6a4f" />
            ) : (
              <Text style={styles.secondaryButtonText}>Choose Video</Text>
            )}
          </Pressable>

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
    backgroundColor: "#f7f9f7",
  },
  container: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 48,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#2d6a4f",
    marginBottom: 4,
  },
  pageSubtitle: {
    fontSize: 13,
    color: "#666",
    marginBottom: 20,
  },
  fieldGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#444",
    marginBottom: 6,
  },
  captionInput: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
    color: "#222",
    backgroundColor: "#fff",
    minHeight: 80,
    textAlignVertical: "top",
  },
  captionCount: {
    marginTop: 4,
    fontSize: 12,
    color: "#999",
    textAlign: "right",
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
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#2d6a4f",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 12,
  },
  secondaryButtonText: {
    color: "#2d6a4f",
    fontSize: 16,
    fontWeight: "600",
  },
  cancelButton: {
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  cancelButtonText: {
    color: "#888",
    fontSize: 14,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 8,
  },
  stateText: {
    fontSize: 18,
    color: "#2d6a4f",
    textAlign: "center",
    fontWeight: "700",
  },
  stateSubText: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    marginBottom: 16,
  },
});
