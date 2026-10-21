import { z } from "zod";

export const QaFirstScreenObservation = z.strictObject({
  name: z.enum([
    "navigation",
    "resource",
    "fcp",
    "lcp",
    "longtask",
    "boot-start",
    "backend-connected",
    "bootstrap-ready",
    "workspace-ready",
    "splash-commit-raf",
    "splash-hidden-raf",
    "content-commit-raf",
  ]),
  startTime: z.number().finite().min(0).max(30000),
  duration: z.number().finite().min(0).max(30000),
  route: z
    .enum([
      "document",
      "asset",
      "auth",
      "bootstrap",
      "workspaces",
      "sessions",
      "history",
      "profiles",
      "settings",
      "sync",
      "other-api",
    ])
    .optional(),
});

export const QaFirstScreenMetricsBody = z.strictObject({
  runId: z.uuid(),
  // Used only to gate the explicitly configured QA session; never written to metrics logs.
  sessionId: z.string().min(1).max(128),
  observations: z
    .array(QaFirstScreenObservation)
    .max(270)
    .refine((items) => items.filter((item) => item.name === "resource").length <= 200)
    .refine((items) => items.filter((item) => item.name === "longtask").length <= 50),
});
export const QaFirstScreenMetricsResponse = z.strictObject({ ok: z.literal(true) });

export type QaFirstScreenObservation = z.infer<typeof QaFirstScreenObservation>;
export type QaFirstScreenMetricsBody = z.infer<typeof QaFirstScreenMetricsBody>;
