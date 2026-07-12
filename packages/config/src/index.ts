import type { StorageConfig } from "@repo/storage";
import type { TelemetryConfig, TelemetryExporter } from "@repo/telemetry";
import { z } from "zod";

export type RuntimeEnv = "development" | "test" | "production";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const defaultClientOrigins = "http://localhost:3000,http://localhost:4000";
const defaultDatabaseUrl =
  "postgresql://postgres:postgres@localhost:15432/monorepo_template?schema=public";
const defaultBetterAuthUrl = "http://localhost:8000";
const defaultBetterAuthSecret = "dev-change-me";
const productionSecretMinimumLength = 32;

const runtimeEnvSchema = z.enum(["development", "test", "production"]).default("development");
const logLevelSchema = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");
const telemetryExporterSchema = z.enum(["console", "otlp"]).default("console");
const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);
const booleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  return value;
}, z.boolean());

const serverEnvSchema = z
  .object({
    NODE_ENV: runtimeEnvSchema,
    API_PORT: z.coerce.number().int().positive().default(8000),
    AUDIT_MAX_PAGES: z.coerce.number().int().positive().default(20),
    AUTH_SECRET: optionalStringSchema,
    BETTER_AUTH_SECRET: optionalStringSchema,
    BETTER_AUTH_URL: z.string().trim().url().default(defaultBetterAuthUrl),
    CLIENT_ORIGINS: z.string().trim().min(1).default(defaultClientOrigins),
    DATABASE_URL: z.string().trim().min(1).default(defaultDatabaseUrl),
    ENABLE_TELEMETRY: booleanSchema.default(false),
    EMAIL_FROM: z.string().trim().min(1).default("Cek SEO <onboarding@resend.dev>"),
    LOG_LEVEL: logLevelSchema,
    REDIS_URL: z.string().trim().min(1).default("redis://localhost:16379"),
    RESEND_API_KEY: optionalStringSchema,
    SQUIRRELSCAN_API_KEY: optionalStringSchema,
    SQUIRRELSCAN_API_URL: z.string().trim().url().default("https://api.squirrelscan.com"),
    TELEMETRY_API_KEY: optionalStringSchema,
    TELEMETRY_API_KEY_HEADER: z.string().trim().min(1).default("authorization"),
    TELEMETRY_EXPORTER: telemetryExporterSchema,
    TELEMETRY_EXPORTER_OTLP_ENDPOINT: optionalStringSchema,
    TELEMETRY_SERVICE_NAMESPACE: optionalStringSchema,
    USER_MAX_SITES: z.coerce.number().int().positive().default(5),
    USER_MONTHLY_AUDIT_LIMIT: z.coerce.number().int().positive().default(2),
  })
  .superRefine((env, context) => {
    const betterAuthSecret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? defaultBetterAuthSecret;

    if (env.NODE_ENV !== "production") {
      return;
    }

    if (betterAuthSecret === defaultBetterAuthSecret) {
      context.addIssue({
        code: "custom",
        message: "BETTER_AUTH_SECRET must be changed in production.",
        path: ["BETTER_AUTH_SECRET"],
      });
    }

    if (betterAuthSecret.length < productionSecretMinimumLength) {
      context.addIssue({
        code: "custom",
        message: `BETTER_AUTH_SECRET must be at least ${productionSecretMinimumLength} characters in production.`,
        path: ["BETTER_AUTH_SECRET"],
      });
    }
  });

const storageEnvSchema = z.object({
  S3_ACCESS_KEY_ID: z.string().trim().min(1),
  S3_BUCKET: z.string().trim().min(1),
  S3_ENDPOINT: optionalStringSchema,
  S3_FORCE_PATH_STYLE: booleanSchema.default(true),
  S3_PUBLIC_BASE_URL: optionalStringSchema,
  S3_REGION: z.string().trim().min(1).default("auto"),
  S3_SECRET_ACCESS_KEY: z.string().trim().min(1),
});

export function parseServerEnv(environment: NodeJS.ProcessEnv) {
  return serverEnvSchema.parse(environment);
}

export const env = parseServerEnv(process.env);

export const appConfig = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
} as const;

export const apiConfig = {
  port: env.API_PORT,
  clientOrigins: parseCsv(env.CLIENT_ORIGINS),
} as const;

export const betterAuthConfig = {
  secret: env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? defaultBetterAuthSecret,
  trustedOrigins: parseCsv(env.CLIENT_ORIGINS),
  url: env.BETTER_AUTH_URL,
} as const;

export const databaseConfig = {
  url: env.DATABASE_URL,
} as const;

export const squirrelscanConfig = Object.freeze({
  apiKey: env.SQUIRRELSCAN_API_KEY,
  apiUrl: env.SQUIRRELSCAN_API_URL,
} as const);

export const emailConfig = Object.freeze({
  from: env.EMAIL_FROM,
  resendApiKey: env.RESEND_API_KEY,
} as const);

export const auditConfig = Object.freeze({
  maxPages: env.AUDIT_MAX_PAGES,
  userMaxSites: env.USER_MAX_SITES,
  userMonthlyLimit: env.USER_MONTHLY_AUDIT_LIMIT,
} as const);

export const redisConfig = {
  url: env.REDIS_URL,
} as const;

export const loggerConfig = {
  environment: env.NODE_ENV,
  level: env.LOG_LEVEL,
} as const;

export const telemetryConfig = {
  apiKey: env.TELEMETRY_API_KEY,
  apiKeyHeader: env.TELEMETRY_API_KEY_HEADER,
  enabled: env.ENABLE_TELEMETRY,
  environment: env.NODE_ENV,
  exporter: env.TELEMETRY_EXPORTER as TelemetryExporter,
  otlpEndpoint: env.TELEMETRY_EXPORTER_OTLP_ENDPOINT,
  serviceNamespace: env.TELEMETRY_SERVICE_NAMESPACE,
} satisfies TelemetryConfig;

export function getStorageConfig(): StorageConfig {
  const storageEnv = storageEnvSchema.parse(process.env);

  return {
    accessKeyId: storageEnv.S3_ACCESS_KEY_ID,
    bucket: storageEnv.S3_BUCKET,
    endpoint: storageEnv.S3_ENDPOINT,
    forcePathStyle: storageEnv.S3_FORCE_PATH_STYLE,
    publicBaseUrl: storageEnv.S3_PUBLIC_BASE_URL,
    region: storageEnv.S3_REGION,
    secretAccessKey: storageEnv.S3_SECRET_ACCESS_KEY,
  };
}

function parseCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
