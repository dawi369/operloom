import { createElement } from "react";

import {
  defineWebModule,
  type ArtifactRendererProps,
  type ToolResultRendererProps,
  type WebRuntimeModule,
} from "@operloom/agent-sdk/web";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The review report card: outcome, word count and the reviewed excerpt. */
export const DocumentReviewReport = ({ artifact }: ArtifactRendererProps) => {
  const data = artifact.data ?? {};
  return createElement(
    "section",
    { "data-runtime-renderer": "document-review-report" },
    createElement("h3", null, artifact.title ?? "Document review report"),
    createElement(
      "p",
      null,
      `${text(data.documentId)} · ${text(data.outcome)} · ${Number(data.wordCount ?? 0)} words`,
    ),
    createElement("blockquote", null, text(data.excerpt)),
  );
};

/** Inline chat card for a recorded review. */
export const DocumentReviewRecordResult = ({ input, output, status }: ToolResultRendererProps) => {
  const result = (output ?? {}) as Record<string, unknown>;
  return createElement(
    "section",
    { "data-runtime-renderer": "document-review-record" },
    createElement("p", null, `Review ${text(input.documentId)}: ${status}`),
    createElement("p", null, `${Number(result.wordCount ?? 0)} words recorded`),
  );
};

export const web: WebRuntimeModule = defineWebModule({
  packId: "document-review",
  runtimeVersion: "1.0.0",
  compatiblePackVersions: "^1.0.0",
  artifactRenderers: { document_review_report: DocumentReviewReport },
  toolResultRenderers: { "document-review.record": DocumentReviewRecordResult },
  managedStateRenderers: {
    "documents.review": { kind: "generic_detail", version: 1 },
    "documents.summary": { kind: "generic_detail", version: 1 },
  },
});
