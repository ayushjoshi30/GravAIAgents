import Link from "next/link";
import { GravAIWordmark } from "@/brand/Logo";
import { Arrow } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center bg-ground px-5">
      <div className="mx-auto w-full max-w-[640px] py-20">
        <GravAIWordmark height={32} />
        <p className="gv-eyebrow mt-10 text-brand">404</p>
        <h1 className="mt-2 text-[30px]">This page does not exist.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Either the link is wrong or the page has moved. Nothing was lost — this application
          holds no state in its URLs beyond agent, run and application identifiers.
        </p>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {[
            { href: "/", label: "Home", note: "What GravAI is" },
            { href: "/agents", label: "Agent catalog", note: "All fourteen agents" },
            { href: "/docs", label: "Documentation", note: "Quickstart and reference" },
            { href: "/console", label: "Console", note: "Runs, review and usage" },
          ].map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="gv-card flex items-center justify-between gap-3 p-4 transition-colors hover:border-brand-300 hover:bg-brand-50"
              >
                <span>
                  <span className="block text-[14px] font-medium text-ink">{link.label}</span>
                  <span className="gv-help mt-0.5 block">{link.note}</span>
                </span>
                <span className="text-brand">
                  <Arrow />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
