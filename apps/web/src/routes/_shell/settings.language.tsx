import { createFileRoute, redirect } from "@tanstack/react-router";

/** App language lives in General now; old links land on its row. */
export const Route = createFileRoute("/_shell/settings/language")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/general",
      search: { focus: "language" },
      replace: true,
    });
  },
});
