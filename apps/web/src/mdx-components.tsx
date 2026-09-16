import type { MDXComponents } from "mdx/types";
import Link from "next/link";

/**
 * MDX element overrides for the documentation.
 * Typography comes from the .gv-prose block in globals.css; this file exists
 * to route internal links through next/link and to keep anchors accessible.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    a: ({ href, children, ...rest }) => {
      const target = typeof href === "string" ? href : "";
      if (target.startsWith("/")) {
        return (
          <Link href={target} {...rest}>
            {children}
          </Link>
        );
      }
      return (
        <a
          href={target}
          target={target.startsWith("http") ? "_blank" : undefined}
          rel={target.startsWith("http") ? "noreferrer noopener" : undefined}
          {...rest}
        >
          {children}
        </a>
      );
    },
    ...components,
  };
}
