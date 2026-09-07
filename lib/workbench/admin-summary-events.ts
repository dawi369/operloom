export const workbenchSummaryRefreshEvent = "operloom:workbench-summary-refresh";

export type WorkbenchSummaryRefreshSource =
  | "initial"
  | "event"
  | "manual"
  | "drawer-open"
  | "fallback-poll";

export type WorkbenchSummaryRefreshDetail = {
  source?: WorkbenchSummaryRefreshSource;
  force?: boolean;
  minimumGeneratedAt?: string;
};

let refreshTimeout: number | null = null;
let pendingDetail: WorkbenchSummaryRefreshDetail = {};

const laterTimestamp = (left?: string, right?: string) => {
  const leftTime = left ? Date.parse(left) : NaN;
  const rightTime = right ? Date.parse(right) : NaN;
  if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? right : undefined;
  if (!Number.isFinite(rightTime)) return left;
  return rightTime > leftTime ? right : left;
};

const dispatchSummaryRefresh = (detail: WorkbenchSummaryRefreshDetail) => {
  window.dispatchEvent(new CustomEvent(workbenchSummaryRefreshEvent, { detail }));
};

export const requestWorkbenchSummaryRefresh = (
  input: { immediate?: boolean } & WorkbenchSummaryRefreshDetail = {},
) => {
  if (typeof window === "undefined") return;
  pendingDetail = {
    source: input.source ?? pendingDetail.source ?? "event",
    force: Boolean(input.force || pendingDetail.force),
    minimumGeneratedAt: laterTimestamp(pendingDetail.minimumGeneratedAt, input.minimumGeneratedAt),
  };
  if (refreshTimeout) {
    window.clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  if (input.immediate) {
    const detail = pendingDetail;
    pendingDetail = {};
    dispatchSummaryRefresh(detail);
    return;
  }
  refreshTimeout = window.setTimeout(() => {
    refreshTimeout = null;
    const detail = pendingDetail;
    pendingDetail = {};
    dispatchSummaryRefresh(detail);
  }, 250);
};

export const flushWorkbenchSummaryRefresh = () => {
  if (typeof window === "undefined") return;
  if (refreshTimeout) {
    window.clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  const detail = pendingDetail;
  pendingDetail = {};
  dispatchSummaryRefresh(detail);
};
