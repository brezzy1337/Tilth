/**
 * Legal — Terms of Service and Privacy Policy (F-052)
 *
 * Drafted 2026-07-13 to match shipped product behavior: F-051 account
 * soft-delete (30-day grace period), F-037 push notification relay (Expo),
 * F-026 escrow/capture flow (Stripe PaymentIntents held then captured), and
 * GCS-hosted media being publicly accessible by link. This is a single
 * source of truth: the server renders it as HTML pages, mobile renders it as
 * a native screen — neither app hand-writes legal copy of its own.
 *
 * NOT LEGAL ADVICE. The operating entity name and full text require counsel
 * review before app-store submission.
 */

/**
 * One section of a legal document. `bullets`, when present, is a list of
 * plain-text items (any markdown emphasis from the source draft has already
 * been stripped) — a section may carry paragraphs, bullets, or both, but
 * must have at least one of either (see `legal.test.ts`).
 */
export type LegalSection = {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
};

/** A full legal document: a title, a human-readable "last updated" date, and ordered sections. */
export type LegalDocument = {
  title: string;
  /** Human-readable date, e.g. "July 13, 2026" — rendered as-is, not reparsed. */
  lastUpdated: string;
  sections: LegalSection[];
};

export const TERMS_OF_SERVICE: LegalDocument = {
  title: "Terms of Service",
  lastUpdated: "July 13, 2026",
  sections: [
    {
      heading: "Welcome to Tilth",
      paragraphs: [
        'Tilth is a local food marketplace that connects neighbors, gardeners, and small farms ("sellers") with people who want fresh, local produce ("buyers"), and helps local co-ops and farmers markets source from nearby growers. These terms are an agreement between you and Tilth ("we," "us"). By creating an account or using the app, you agree to them.',
      ],
    },
    {
      heading: "Your account",
      paragraphs: [
        "You must be at least 18 years old to use Tilth. Keep your password private and your account information accurate. You are responsible for activity on your account. You can change your password or delete your account at any time in Settings.",
      ],
    },
    {
      heading: "Buying and selling",
      paragraphs: [
        "Tilth is a marketplace and coordination platform. Purchases are transactions between the buyer and the seller — we are not a party to them, and we don't grow, handle, inspect, or guarantee any food sold through the app.",
        "Sellers are solely responsible for the products they list: that they are accurately described, safely grown and handled, and sold in compliance with all laws that apply to them, including state and local cottage-food, food-safety, licensing, and tax rules. If you're not sure what rules apply to your stand, check with your state or county before selling.",
        "Payments are processed by Stripe. When a buyer places an order, payment is authorized and held; it is captured when the seller fulfills the order. Sellers receive payouts through Stripe Connect and pay Tilth a platform fee of 10% of the order subtotal (we'll give notice before changing fees). Optional tips go entirely to the seller. Buyers may request refunds through the app; sellers review and approve or decline them, and certain payment outcomes (like disputes) are governed by Stripe's processes.",
      ],
    },
    {
      heading: "Fulfillment requests (co-ops and markets)",
      paragraphs: [
        "Organizations like co-ops and farmers markets may use Tilth to coordinate sourcing from growers. Fulfillment requests made through the app are coordination tools, not binding purchase orders; any resulting sale, delivery, and payment terms are between the organization and the grower unless made through Tilth checkout.",
      ],
    },
    {
      heading: "Content and conduct",
      paragraphs: [
        "You keep ownership of the photos, videos, and text you post, and you give us a license to host and display them so the app can work. Don't post content that is illegal, deceptive, infringing, or abusive; don't misrepresent what you're selling; don't use Tilth to spam or harass anyone. You can block other users and report messages in the app. We may remove content or suspend accounts that violate these terms or put the community at risk.",
      ],
    },
    {
      heading: "Deleting your account",
      paragraphs: [
        "You can delete your account in Settings. Deletion is blocked while you have orders in progress. After you confirm, your account is deactivated immediately and permanently anonymized after a 30-day grace period — logging back in within those 30 days restores it. Records we're required to keep (like transaction history) are retained in anonymized form.",
      ],
    },
    {
      heading: "Disclaimers and limits",
      paragraphs: [
        'Tilth is provided "as is." To the fullest extent allowed by law, we disclaim warranties of any kind and are not liable for indirect, incidental, or consequential damages, or for disputes between buyers and sellers, including those relating to food quality or safety. Our total liability for any claim is limited to the greater of $100 or the amounts you paid to Tilth in the twelve months before the claim.',
      ],
    },
    {
      heading: "Changes and contact",
      paragraphs: [
        "We may update these terms as Tilth grows; if changes are material we'll notify you in the app. These terms are governed by the laws of the State of Minnesota. Questions? Email support@tilth.market.",
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDocument = {
  title: "Privacy Policy",
  lastUpdated: "July 13, 2026",
  sections: [
    {
      heading: "What this covers",
      paragraphs: [
        "This policy explains what information Tilth collects, how we use it, and the choices you have. We built Tilth for neighbors, so the short version is: we collect what the marketplace needs to work, we don't sell your data, and you can delete your account in the app.",
      ],
    },
    {
      heading: "What we collect",
      paragraphs: [],
      bullets: [
        "Account: your email, username, and password. Passwords are stored only as a cryptographic hash — we can't read them.",
        "Your stand (sellers): store name, description, photos, listings, and the stand's address and location, which are shown to nearby buyers.",
        "Location: the app uses your device's location to show nearby stalls, places, and produce. Your device location is used for those searches and is not stored on our servers. (Seller stand addresses, which sellers enter themselves, are stored.)",
        "Orders and payments: order details, amounts, tips, and fulfillment status. Payments are processed by Stripe — your card details go directly to Stripe and are never stored on our servers. Sellers' payout and identity-verification information is collected by Stripe Connect under Stripe's privacy policy.",
        "Messages: conversations between buyers and sellers (including structured fulfillment requests) are stored so your inbox works. If a message is reported, our team reviews it.",
        "Photos and videos: garden and listing photos you upload are stored on Google Cloud Storage and are publicly accessible to anyone with the link; videos are processed and hosted by Mux. Don't post media you want to keep private.",
        "Push notifications: if you enable them, we store your device's push token. Notification previews (truncated) are delivered via Expo's push service.",
      ],
    },
    {
      heading: "How we use it",
      paragraphs: [
        "To run the marketplace: showing nearby stalls and produce, processing orders, delivering messages and notifications, computing seller trust badges from order history, preventing abuse (including rate limits and block lists), and improving the app. We don't sell your personal information, and we don't use it for third-party advertising.",
      ],
    },
    {
      heading: "Who we share it with",
      paragraphs: [
        "Service providers that make Tilth work: Stripe (payments and seller onboarding), Google Cloud (hosting, database, and media storage), Expo (push notification delivery), and Mux (video processing). Each receives only what it needs. Map data for community places comes from OpenStreetMap (© OpenStreetMap contributors) and the USDA local food directories. We may disclose information if required by law.",
      ],
    },
    {
      heading: "Your choices",
      paragraphs: [],
      bullets: [
        "Notifications: toggle push notifications off in Settings (or in your device's system settings).",
        "Blocking: block or unblock users in Messages and Settings; blocked users can't message you.",
        "Delete your account: Settings → Delete account. Your account deactivates immediately, disappears from the marketplace, and is permanently anonymized after a 30-day grace period (log back in within 30 days to restore it). Transaction records we must retain are kept in anonymized form; your email, username, and password hash are scrubbed.",
      ],
    },
    {
      heading: "Data retention and security",
      paragraphs: [
        "We keep your information while your account is active. Passwords are hashed with scrypt; connections use TLS; production secrets are managed in Google Secret Manager. No system is perfectly secure — if we learn of a breach affecting you, we'll notify you as the law requires.",
      ],
    },
    {
      heading: "Children",
      paragraphs: [
        "Tilth is not for children under 18, and we don't knowingly collect their information.",
      ],
    },
    {
      heading: "Changes and contact",
      paragraphs: [
        "We'll post updates here and note the date at the top; material changes get an in-app notice. Tilth operates from Minnesota, USA. Questions or requests: support@tilth.market.",
      ],
    },
  ],
};
