import createMDX from "@next/mdx";
import remarkGfm from "remark-gfm";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // MDX pages live alongside TSX pages under src/app.
  pageExtensions: ["ts", "tsx", "mdx"],
  reactStrictMode: true,
  poweredByHeader: false,
  // Dev and production builds get separate output directories.
  //
  // Sharing one `.next` means that running `next build` and then `next dev`
  // leaves a production bundle where dev mode expects its own chunks, and every
  // route then fails with `ENOENT: .next/static/chunks/webpack.js` — which
  // surfaces in the browser as a bare "Internal Server Error" with nothing in
  // it to suggest a stale cache. Splitting the directories makes the two modes
  // unable to corrupt each other. Deployment still reads `.next`.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  // Served under a path prefix when it shares a hostname with another app.
  // Both are build-time: Next bakes the prefix into every asset URL, so this
  // cannot be switched by an environment variable at runtime. Unset locally,
  // which is why `npm run dev` still serves from the root.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // A standalone build ships its own minimal server and only the node_modules
  // it actually reached, so the server does not need the toolchain.
  output: process.env.NEXT_STANDALONE ? "standalone" : undefined,
  // There are no console redirects.
  //
  // A previous iteration rebuilt the console around six destinations named for
  // intent, and redirected `/console`, `/console/review`, `/console/mcp` and
  // `/console/admin` onto the new names. That IA has been reverted to the one
  // production actually serves, so all four of those routes are real pages
  // again and every redirect here pointed somewhere that no longer exists —
  // `/console/mcp` sent a 307 straight into a 404.
  //
  // They were `permanent: false` precisely so this could be undone without a
  // trail of browsers that had cached a 308 and could not be talked out of it.
  // That caution paid for itself; keep it for any future move.

  // The console talks to the GravAI API from the browser, so the only headers
  // that matter here are the ones protecting this origin.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

const withMDX = createMDX({
  options: {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [],
  },
});

export default withMDX(nextConfig);
