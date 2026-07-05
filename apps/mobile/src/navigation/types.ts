/**
 * Navigation param lists — single source of truth for screen names and params.
 *
 * PreAuthStackParamList: screens reachable before sign-in.
 * AuthedStackParamList:  root authenticated stack — the tab navigator
 *   (MainTabs) plus detail/flow screens pushed above the tab bar.
 * TabParamList:          the 5 bottom-tab screens (Home, Search, Sell,
 *   Messages, Learn) nested under AuthedStackParamList["MainTabs"].
 *
 * Import the relevant type in every screen that calls useNavigation() or
 * useRoute(), and pick the correct navigator-specific prop type.
 */

import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type {
  CompositeNavigationProp,
  NavigatorScreenParams,
} from "@react-navigation/native";

export type PreAuthStackParamList = {
  Hero: undefined;
  LogIn: undefined;
  SignUp: undefined;
};

export type TabParamList = {
  Home: undefined;
  Search: { initialQuery?: string } | undefined;
  Sell: undefined;
  Messages: undefined;
  Learn: undefined;
};

export type AuthedStackParamList = {
  MainTabs: NavigatorScreenParams<TabParamList> | undefined;
  Cart: undefined;
  Orders: undefined;
  OrderDetail: { orderId: string };
  StoreOrders: undefined;
  StoreProfile: { storeId: string; storeName?: string };
};

// Convenience aliases
export type PreAuthNavigationProp = NativeStackNavigationProp<PreAuthStackParamList>;

export type AuthedNavigationProp = NativeStackNavigationProp<AuthedStackParamList>;

export type TabNavigationProp = BottomTabNavigationProp<TabParamList>;

/**
 * Composite nav prop for tab screens that also need to reach root-stack
 * detail screens (e.g. Home → StoreProfile/Cart/Orders, Search →
 * StoreProfile). Parameterise the first generic's second arg with the
 * specific tab route name when a screen needs its own route-specific
 * navigation methods.
 */
export type HomeTabNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, "Home">,
  NativeStackNavigationProp<AuthedStackParamList>
>;

export type SearchTabNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, "Search">,
  NativeStackNavigationProp<AuthedStackParamList>
>;

/**
 * @deprecated Use PreAuthStackParamList, TabParamList, or AuthedStackParamList.
 * Kept temporarily so any stale import compiles during the migration.
 */
export type RootStackParamList = PreAuthStackParamList & AuthedStackParamList & TabParamList;

export type RootStackNavigationProp = NativeStackNavigationProp<RootStackParamList>;
