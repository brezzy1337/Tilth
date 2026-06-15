/**
 * HeroScreen — initial landing screen (pre-auth).
 * Navigates to LogIn or SignUp; never directly to Home
 * (the navigation gate in App.tsx handles that after sign-in).
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { PreAuthStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<PreAuthStackParamList, "Hero">;

export function HeroScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.title}>HomeGrown</Text>
        <Text style={styles.subtitle}>Local food, straight from the source.</Text>

        <View style={styles.buttonRow}>
          <Pressable
            style={styles.button}
            onPress={() => navigation.navigate("LogIn")}
          >
            <Text style={styles.buttonText}>Log In</Text>
          </Pressable>

          <Pressable
            style={[styles.button, styles.buttonSecondary]}
            onPress={() => navigation.navigate("SignUp")}
          >
            <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
              Sign Up
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#fff",
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 36,
    fontWeight: "bold",
    color: "#2d6a4f",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#555",
    marginBottom: 48,
    textAlign: "center",
  },
  buttonRow: {
    width: "100%",
    gap: 12,
  },
  button: {
    backgroundColor: "#2d6a4f",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#2d6a4f",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  buttonTextSecondary: {
    color: "#2d6a4f",
  },
});
