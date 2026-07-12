import { describe, expect, it } from "vitest";
import { auditConfig, emailConfig, parseServerEnv, squirrelscanConfig } from "./index";

const productionEnv = {
  BETTER_AUTH_URL: "http://localhost:8000",
  CLIENT_ORIGINS: "http://localhost:3000,http://localhost:4000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:15432/monorepo_template?schema=public",
  NODE_ENV: "production",
  REDIS_URL: "redis://localhost:16379",
} satisfies NodeJS.ProcessEnv;

describe("server environment config", () => {
  it("exports frozen SEO config slices", () => {
    expect(Object.isFrozen(squirrelscanConfig)).toBe(true);
    expect(Object.isFrozen(emailConfig)).toBe(true);
    expect(Object.isFrozen(auditConfig)).toBe(true);
  });

  it("uses SEO audit defaults", () => {
    const env = parseServerEnv({ NODE_ENV: "test" });

    expect(env).toMatchObject({
      AUDIT_MAX_PAGES: 20,
      EMAIL_FROM: "Cek SEO <onboarding@resend.dev>",
      SQUIRRELSCAN_API_URL: "https://api.squirrelscan.com",
      USER_MAX_SITES: 5,
      USER_MONTHLY_AUDIT_LIMIT: 2,
    });
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.SQUIRRELSCAN_API_KEY).toBeUndefined();
  });

  it("coerces positive audit limits and trims optional keys", () => {
    const env = parseServerEnv({
      AUDIT_MAX_PAGES: "8",
      RESEND_API_KEY: "  resend-key  ",
      SQUIRRELSCAN_API_KEY: "  squirrel-key  ",
      USER_MAX_SITES: "3",
      USER_MONTHLY_AUDIT_LIMIT: "4",
    });

    expect(env).toMatchObject({
      AUDIT_MAX_PAGES: 8,
      RESEND_API_KEY: "resend-key",
      SQUIRRELSCAN_API_KEY: "squirrel-key",
      USER_MAX_SITES: 3,
      USER_MONTHLY_AUDIT_LIMIT: 4,
    });
  });

  it.each([
    ["AUDIT_MAX_PAGES", "0"],
    ["AUDIT_MAX_PAGES", "1.5"],
    ["USER_MAX_SITES", "-1"],
    ["USER_MONTHLY_AUDIT_LIMIT", "0"],
  ])("rejects invalid %s values", (name, value) => {
    expect(() => parseServerEnv({ [name]: value })).toThrow();
  });

  it("rejects an invalid squirrelscan API URL", () => {
    expect(() => parseServerEnv({ SQUIRRELSCAN_API_URL: "not-a-url" })).toThrow();
  });

  it("rejects the default auth secret in production", () => {
    expect(() =>
      parseServerEnv({
        ...productionEnv,
        BETTER_AUTH_SECRET: "dev-change-me",
      }),
    ).toThrow("BETTER_AUTH_SECRET must be changed in production.");
  });

  it("rejects short auth secrets in production", () => {
    expect(() =>
      parseServerEnv({
        ...productionEnv,
        BETTER_AUTH_SECRET: "short-secret",
      }),
    ).toThrow("BETTER_AUTH_SECRET must be at least 32 characters in production.");
  });

  it("accepts a strong auth secret in production", () => {
    expect(() =>
      parseServerEnv({
        ...productionEnv,
        BETTER_AUTH_SECRET: "a-production-secret-with-32-chars",
      }),
    ).not.toThrow();
  });
});
