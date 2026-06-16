/**
 * Navigation param lists — single source of truth for screen names and params.
 *
 * PreAuthStackParamList: screens reachable before sign-in.
 * AuthedStackParamList:  screens reachable after sign-in.
 *
 * Import the relevant type in every screen that calls useNavigation() or
 * useRoute(), and pick the correct navigator-specific prop type.
 */

import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

export type PreAuthStackParamList = {
  Hero: undefined;
  LogIn: undefined;
  SignUp: undefined;
};

export type AuthedStackParamList = {
  Home: undefined;
  YourStand: undefined;
};

// Convenience aliases
export type PreAuthNavigationProp = NativeStackNavigationProp<PreAuthStackParamList>;

export type AuthedNavigationProp = NativeStackNavigationProp<AuthedStackParamList>;

/**
 * @deprecated Use PreAuthStackParamList or AuthedStackParamList.
 * Kept temporarily so any stale import compiles during the migration.
 */
export type RootStackParamList = PreAuthStackParamList & AuthedStackParamList;

export type RootStackNavigationProp = NativeStackNavigationProp<RootStackParamList>;
