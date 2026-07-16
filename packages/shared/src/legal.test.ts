import { describe, it, expect } from "vitest";
import { TERMS_OF_SERVICE, PRIVACY_POLICY, type LegalDocument } from "./index.js";

const LAST_UPDATED_PATTERN = /^[A-Z][a-z]+ \d{1,2}, \d{4}$/;

const documents: [string, LegalDocument][] = [
  ["TERMS_OF_SERVICE", TERMS_OF_SERVICE],
  ["PRIVACY_POLICY", PRIVACY_POLICY],
];

describe.each(documents)("%s — structural sanity", (_name, doc) => {
  it("has at least 5 sections", () => {
    expect(doc.sections.length).toBeGreaterThanOrEqual(5);
  });

  it("has a lastUpdated matching the human-readable date pattern", () => {
    expect(doc.lastUpdated).toMatch(LAST_UPDATED_PATTERN);
  });

  it("every section has a heading and at least one paragraph or bullet", () => {
    for (const section of doc.sections) {
      expect(section.heading.length).toBeGreaterThan(0);
      const hasParagraphs = section.paragraphs.length > 0;
      const hasBullets = (section.bullets?.length ?? 0) > 0;
      expect(hasParagraphs || hasBullets).toBe(true);
    }
  });
});

describe("content tripwires — these assert claims that must stay true to the code", () => {
  const privacyText = PRIVACY_POLICY.sections
    .flatMap((s) => [...s.paragraphs, ...(s.bullets ?? [])])
    .join(" ");
  const tosText = TERMS_OF_SERVICE.sections
    .flatMap((s) => [...s.paragraphs, ...(s.bullets ?? [])])
    .join(" ");

  it("privacy policy mentions the 30-day grace period (F-051 soft-delete)", () => {
    expect(privacyText).toContain("30-day grace");
  });

  it("privacy policy states device location is not stored on our servers", () => {
    expect(privacyText).toContain("not stored on our servers");
  });

  it("privacy policy states uploaded media is publicly accessible (GCS public media)", () => {
    expect(privacyText).toContain("publicly accessible");
  });

  it("privacy policy mentions scrypt password hashing", () => {
    expect(privacyText).toContain("scrypt");
  });

  it("terms of service mentions the 10% platform fee (F-026 escrow)", () => {
    expect(tosText).toContain("10%");
  });

  it("terms of service mentions the 18-years-old minimum age", () => {
    expect(tosText).toContain("18 years old");
  });

  it("privacy policy mentions garden likes and comments (F-053 garden social)", () => {
    expect(privacyText).toContain("likes and comments");
  });
});
