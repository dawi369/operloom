import {
  type WorkbenchSummaryRefreshDetail,
  type WorkbenchSummaryRefreshSource,
  workbenchSummaryRefreshEvent,
} from "./admin-summary-events";
import type { AdminSummaryProjection } from "./admin-summary-projection";
import type { CloudflareAdminSummaryResponse } from "./workbench-types";
import { readJsonResponse } from "./read-json-response";

const adminSummaryPath = "/api/workbench/admin-summary";
const automatedRefreshCooldownMs = 900;
const maximumCatchUpAttempts = 3;
const catchUpWindowMs = 10_000;
const emptyRefreshCounts: Record<WorkbenchSummaryRefreshSource, number> = {
  initial: 0,
  event: 0,
  manual: 0,
  "drawer-open": 0,
  "fallback-poll": 0,
};

export type AdminSummaryResourceSnapshot = {
  summary: CloudflareAdminSummaryResponse["summary"] | null;
  error: string | null;
  isLoading: boolean;
  lastLoadedAt: number | null;
  lastRefreshSource: WorkbenchSummaryRefreshSource | null;
  lastDurationMs: number | null;
  lastProjection: AdminSummaryProjection | null;
  refreshCounts: Record<WorkbenchSummaryRefreshSource, number>;
  syncStatus: "idle" | "catching_up" | "exhausted";
};

type RefreshInput = {
  source?: WorkbenchSummaryRefreshSource;
  force?: boolean;
  projection?: AdminSummaryProjection;
  minimumGeneratedAt?: string;
  catchUpAttempt?: number;
  catchUpDeadlineAt?: number;
};

const initialSnapshot: AdminSummaryResourceSnapshot = {
  summary: null,
  error: null,
  isLoading: false,
  lastLoadedAt: null,
  lastRefreshSource: null,
  lastDurationMs: null,
  lastProjection: null,
  refreshCounts: emptyRefreshCounts,
  syncStatus: "idle",
};

let snapshot = initialSnapshot;
let inFlight: Promise<AdminSummaryResourceSnapshot> | null = null;
let inFlightProjection: AdminSummaryProjection | null = null;
let scheduledRefresh: number | null = null;
let scheduledRefreshAt: number | null = null;
let pendingRefreshInput: RefreshInput | null = null;
let eventListenerAttached = false;
let latestRequestSequence = 0;
let projectionPreference: AdminSummaryProjection = "compact";
const listeners = new Set<() => void>();

const sourcePriority: Record<WorkbenchSummaryRefreshSource, number> = {
  initial: 0,
  "fallback-poll": 1,
  event: 2,
  "drawer-open": 3,
  manual: 4,
};

const laterTimestamp = (left?: string, right?: string) => {
  const leftTime = left ? Date.parse(left) : NaN;
  const rightTime = right ? Date.parse(right) : NaN;
  if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? right : undefined;
  if (!Number.isFinite(rightTime)) return left;
  return rightTime > leftTime ? right : left;
};

const mergeRefreshInput = (left: RefreshInput | null, right: RefreshInput): RefreshInput => {
  if (!left) return right;
  const leftSource = left.source ?? "event";
  const rightSource = right.source ?? "event";
  const leftMinimumTime = left.minimumGeneratedAt ? Date.parse(left.minimumGeneratedAt) : NaN;
  const rightMinimumTime = right.minimumGeneratedAt ? Date.parse(right.minimumGeneratedAt) : NaN;
  const rightAdvancesMinimum =
    Number.isFinite(rightMinimumTime) &&
    (!Number.isFinite(leftMinimumTime) || rightMinimumTime > leftMinimumTime);
  const leftAdvancesMinimum =
    Number.isFinite(leftMinimumTime) &&
    (!Number.isFinite(rightMinimumTime) || leftMinimumTime > rightMinimumTime);
  const catchUpAttempt = rightAdvancesMinimum
    ? right.catchUpAttempt
    : leftAdvancesMinimum
      ? left.catchUpAttempt
      : Math.max(left.catchUpAttempt ?? 0, right.catchUpAttempt ?? 0);
  const catchUpDeadlineAt = rightAdvancesMinimum
    ? right.catchUpDeadlineAt
    : leftAdvancesMinimum
      ? left.catchUpDeadlineAt
      : left.catchUpDeadlineAt === undefined && right.catchUpDeadlineAt === undefined
        ? undefined
        : Math.max(left.catchUpDeadlineAt ?? 0, right.catchUpDeadlineAt ?? 0);
  return {
    ...left,
    ...right,
    source: sourcePriority[rightSource] >= sourcePriority[leftSource] ? rightSource : leftSource,
    force: Boolean(left.force || right.force),
    minimumGeneratedAt: laterTimestamp(left.minimumGeneratedAt, right.minimumGeneratedAt),
    catchUpAttempt,
    catchUpDeadlineAt,
  };
};

const summaryMeetsMinimum = (
  summary: CloudflareAdminSummaryResponse["summary"] | null | undefined,
  minimumGeneratedAt?: string,
) => {
  if (!minimumGeneratedAt) return true;
  const requiredTime = Date.parse(minimumGeneratedAt);
  const generatedTime = summary?.generatedAt ? Date.parse(summary.generatedAt) : NaN;
  return Number.isFinite(requiredTime) && Number.isFinite(generatedTime)
    ? generatedTime >= requiredTime
    : false;
};

const notify = () => {
  for (const listener of listeners) listener();
};

const setSnapshot = (next: AdminSummaryResourceSnapshot) => {
  snapshot = next;
  notify();
};

const cancelScheduledRefresh = () => {
  if (scheduledRefresh !== null && typeof window !== "undefined") {
    window.clearTimeout(scheduledRefresh);
  }
  scheduledRefresh = null;
  scheduledRefreshAt = null;
  pendingRefreshInput = null;
};

export const getAdminSummarySnapshot = () => snapshot;

export const clearAdminSummaryResource = () => {
  cancelScheduledRefresh();
  inFlight = null;
  inFlightProjection = null;
  latestRequestSequence += 1;
  setSnapshot(initialSnapshot);
};

export const setAdminSummaryProjectionPreference = (projection: AdminSummaryProjection) => {
  projectionPreference = projection;
};

export const refreshAdminSummary = async (
  input: RefreshInput = {},
): Promise<AdminSummaryResourceSnapshot> => {
  const source = input.source ?? "event";
  const projection = input.projection ?? projectionPreference;
  const now = Date.now();

  if (!input.force) {
    if (inFlight && inFlightProjection === projection) return inFlight;
    if (snapshot.lastLoadedAt && now - snapshot.lastLoadedAt < automatedRefreshCooldownMs) {
      void scheduleAdminSummaryRefresh(input);
      return snapshot;
    }
  }

  const requestSequence = latestRequestSequence + 1;
  latestRequestSequence = requestSequence;
  const refreshCounts = {
    ...snapshot.refreshCounts,
    [source]: snapshot.refreshCounts[source] + 1,
  };

  setSnapshot({
    ...snapshot,
    isLoading: true,
    error: null,
    lastRefreshSource: source,
    lastProjection: projection,
    refreshCounts,
  });

  const startedAt = Date.now();
  const request = fetch(`${adminSummaryPath}?projection=${encodeURIComponent(projection)}`, {
    cache: "no-store",
  })
    .then((response) =>
      readJsonResponse<CloudflareAdminSummaryResponse>(
        response,
        "Failed to load Cloudflare admin summary",
      ),
    )
    .then((body) => {
      const caughtUp = summaryMeetsMinimum(body.summary, input.minimumGeneratedAt);
      const catchUpAttempt = input.catchUpAttempt ?? 0;
      const catchUpDeadlineAt = input.catchUpDeadlineAt ?? startedAt + catchUpWindowMs;
      const shouldRetry =
        !caughtUp && catchUpAttempt < maximumCatchUpAttempts && Date.now() < catchUpDeadlineAt;
      const next: AdminSummaryResourceSnapshot = {
        summary: body.summary ?? null,
        error: null,
        isLoading: false,
        lastLoadedAt: Date.now(),
        lastRefreshSource: source,
        lastDurationMs: Date.now() - startedAt,
        lastProjection: projection,
        refreshCounts,
        syncStatus: caughtUp ? "idle" : shouldRetry ? "catching_up" : "exhausted",
      };
      if (requestSequence === latestRequestSequence) setSnapshot(next);
      if (shouldRetry) {
        void scheduleAdminSummaryRefresh({
          ...input,
          force: false,
          catchUpAttempt: catchUpAttempt + 1,
          catchUpDeadlineAt,
        });
      }
      return next;
    })
    .catch((error) => {
      const next = {
        ...snapshot,
        error: error instanceof Error ? error.message : "Failed to load admin summary",
        isLoading: false,
        lastRefreshSource: source,
        lastDurationMs: Date.now() - startedAt,
        lastProjection: projection,
        refreshCounts,
        syncStatus: input.minimumGeneratedAt ? ("exhausted" as const) : snapshot.syncStatus,
      };
      if (requestSequence === latestRequestSequence) setSnapshot(next);
      return next;
    })
    .finally(() => {
      if (inFlight === request) {
        inFlight = null;
        inFlightProjection = null;
      }
    });

  if (!input.force) {
    inFlight = request;
    inFlightProjection = projection;
  }
  return request;
};

export const scheduleAdminSummaryRefresh = (input: RefreshInput = {}) => {
  if (typeof window === "undefined") return Promise.resolve(snapshot);
  if (input.force) return refreshAdminSummary(input);
  pendingRefreshInput = mergeRefreshInput(pendingRefreshInput, input);
  const now = Date.now();
  const nextRefreshAt = snapshot.lastLoadedAt
    ? Math.max(now, snapshot.lastLoadedAt + automatedRefreshCooldownMs)
    : now;
  if (
    scheduledRefresh !== null &&
    scheduledRefreshAt !== null &&
    scheduledRefreshAt <= nextRefreshAt
  ) {
    return Promise.resolve(snapshot);
  }
  if (scheduledRefresh !== null) window.clearTimeout(scheduledRefresh);
  scheduledRefreshAt = nextRefreshAt;
  scheduledRefresh = window.setTimeout(
    () => {
      scheduledRefresh = null;
      scheduledRefreshAt = null;
      const pending = pendingRefreshInput ?? input;
      pendingRefreshInput = null;
      void refreshAdminSummary(pending);
    },
    Math.max(0, nextRefreshAt - now),
  );
  return Promise.resolve(snapshot);
};

export const subscribeAdminSummary = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cancelScheduledRefresh();
  };
};

export const ensureAdminSummaryEventListener = () => {
  if (typeof window === "undefined" || eventListenerAttached) return;
  eventListenerAttached = true;
  window.addEventListener(workbenchSummaryRefreshEvent, (event) => {
    const detail =
      "detail" in event && event.detail && typeof event.detail === "object"
        ? (event.detail as WorkbenchSummaryRefreshDetail)
        : {};
    void scheduleAdminSummaryRefresh({
      source: detail.source ?? "event",
      force: detail.force,
      projection: projectionPreference,
      minimumGeneratedAt: detail.minimumGeneratedAt,
    });
  });
};

export const resetAdminSummaryResourceForTests = () => {
  cancelScheduledRefresh();
  snapshot = initialSnapshot;
  inFlight = null;
  inFlightProjection = null;
  eventListenerAttached = false;
  projectionPreference = "compact";
  listeners.clear();
};
