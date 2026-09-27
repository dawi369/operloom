import type { WorkflowReviewDescriptor } from "@operloom/client";

export function WorkflowReviewDetails({ review }: { review: WorkflowReviewDescriptor }) {
  return (
    <section aria-label="Workflow review content" className="mt-3 min-w-0 space-y-2 text-xs">
      <p className="text-muted-foreground">
        Approval records your review of this content. Later actions still require authorization.
      </p>
      <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 whitespace-pre-wrap break-words">
        {JSON.stringify(review.payload, null, 2)}
      </pre>
      <p>
        Expires: <time dateTime={review.expiresAt}>{review.expiresAt}</time>
      </p>
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">Content fingerprint</summary>
        <code className="block break-all">{review.requestHash}</code>
      </details>
    </section>
  );
}
