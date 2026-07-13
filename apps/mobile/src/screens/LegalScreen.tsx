/**
 * LegalScreen — native in-app renderer for Terms of Service / Privacy Policy
 * (F-052).
 *
 * Reads route.params.doc ("terms" | "privacy") and renders the matching
 * `LegalDocument` from `@homegrown/shared` (`TERMS_OF_SERVICE` /
 * `PRIVACY_POLICY`) — the single source of truth also used to generate the
 * public HTML twins the server serves at api.tilth.market/legal/{terms,
 * privacy} (used for App Store Connect metadata; see src/constants/legal.ts).
 * Neither app hand-writes legal copy of its own.
 *
 * Layout: screen header title comes from the document's own `title` (set via
 * navigation options in App.tsx, not repeated here) — this screen's content
 * opens with a "Last updated {date}" caption, then each section as an
 * in-content SectionHeader (icon variant, matching SettingsScreen's section
 * idiom) followed by paragraphs as body text and, when present, bullets as a
 * hanging-indent "•" list. Plain ScrollView (no FlatList — documents are a
 * few KB of static text, not a long homogeneous list) with safe-area bottom
 * padding.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { TERMS_OF_SERVICE, PRIVACY_POLICY, type LegalDocument } from "@homegrown/shared";
import { SectionHeader } from "../components/SectionHeader";
import type { AuthedStackParamList } from "../navigation/types";
import { colors, spacing, type } from "../theme";

type Props = NativeStackScreenProps<AuthedStackParamList, "Legal">;

const DOCUMENTS: Record<"terms" | "privacy", LegalDocument> = {
  terms: TERMS_OF_SERVICE,
  privacy: PRIVACY_POLICY,
};

export function LegalScreen({ route }: Props) {
  const { doc } = route.params;
  const document = DOCUMENTS[doc];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.lastUpdated}>Last updated {document.lastUpdated}</Text>

        {document.sections.map((section) => (
          <View key={section.heading} style={styles.section}>
            <SectionHeader
              icon="document-text-outline"
              title={section.heading}
              tint={colors.primarySoft}
              iconColor={colors.primary}
            />
            {section.paragraphs.map((paragraph, index) => (
              <Text key={index} style={styles.paragraph}>
                {paragraph}
              </Text>
            ))}
            {section.bullets ? (
              <View style={styles.bulletList}>
                {section.bullets.map((bullet, index) => (
                  <View key={index} style={styles.bulletRow}>
                    <Text style={styles.bulletMark}>{"•"}</Text>
                    <Text style={styles.bulletText}>{bullet}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  lastUpdated: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.xl,
  },
  section: {
    marginBottom: spacing.xxl,
    gap: spacing.sm,
  },
  paragraph: {
    fontSize: type.body.fontSize,
    color: colors.text,
    lineHeight: type.body.fontSize * 1.5,
  },
  bulletList: {
    gap: spacing.sm,
  },
  bulletRow: {
    flexDirection: "row",
    paddingLeft: spacing.sm,
  },
  bulletMark: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    width: spacing.lg,
    lineHeight: type.body.fontSize * 1.5,
  },
  bulletText: {
    flex: 1,
    fontSize: type.body.fontSize,
    color: colors.text,
    lineHeight: type.body.fontSize * 1.5,
  },
});
