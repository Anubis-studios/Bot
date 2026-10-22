import type { ReactNode } from "react";

/** One block of the review tab: a quiet heading, an optional aside, its rows. */
export const PrSection = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
    <div className="text-muted-foreground flex h-6 min-w-0 items-center justify-between gap-2 text-xs">
      <h3 className="shrink-0 font-medium">{title}</h3>
      {aside}
    </div>
    {children}
  </section>
);
