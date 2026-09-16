import { DocsNav } from "@/components/site/DocsNav";
import { Container } from "@/components/site/Page";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Container className="py-10 sm:py-14">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-14">
        <DocsNav />
        <article className="gv-prose min-w-0">{children}</article>
      </div>
    </Container>
  );
}
