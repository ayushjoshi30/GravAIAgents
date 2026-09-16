import type { Metadata } from "next";
import { ConsoleShell } from "@/components/console/ConsoleShell";

export const metadata: Metadata = {
  title: {
    default: "Console",
    template: "%s · GravAI Console",
  },
  description:
    "The GravAI production console: runs, review queue, applications, usage dashboards, audit explorer and administration.",
  robots: { index: false, follow: false },
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
