import { workbenchProduct } from "@/lib/workbench/product-identity";

import { cn } from "@/lib/utils";

export function WorkbenchMark({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="bg-primary text-primary-foreground relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-[0.4rem] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
          <path
            d="M5 7h10a4 4 0 0 1 0 8H9"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M19 17H9a4 4 0 0 1 0-8h6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="min-w-0 leading-none">
        <span className="font-display text-foreground block truncate text-[13px] font-semibold tracking-[-0.01em]">
          {workbenchProduct.displayName}
        </span>
        <span className="text-muted-foreground mt-1 block truncate font-mono text-[9px] tracking-[0.14em] uppercase">
          {compact ? "workbench" : "agent workbench"}
        </span>
      </span>
    </div>
  );
}
