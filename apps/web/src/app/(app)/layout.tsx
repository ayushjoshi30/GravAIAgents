import { SiteFooter } from "@/components/site/SiteFooter";

/**
 * The layout for pages that are an application rather than a document.
 *
 * It differs from `(site)` in one respect that matters: there is no
 * `SiteHeader`. A 4rem marketing bar above a canvas costs the canvas 4rem it
 * cannot spare — on a 700px laptop viewport that is six per cent of the screen
 * spent on links to pages the visitor is not currently reading — and it makes
 * the thing read as a page with a widget on it rather than as a tool. The
 * application supplies its own bar, carrying the document's name and its
 * actions, which is what a person in a canvas actually needs within reach.
 *
 * The footer stays. Everything below the application's first screen is ordinary
 * page content — linkable, indexable, printable — and cutting a site's footer
 * off that content would strand it.
 *
 * The skip link points at `#main` exactly as `(site)` does, so the two layouts
 * behave the same for anyone arriving by keyboard.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="gv-skip">
        Skip to content
      </a>
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
