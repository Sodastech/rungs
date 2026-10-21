import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

// Served from GitHub Pages at https://sodastech.github.io/rungs/. With a custom domain later,
// set `site` to it and remove `base`.
export default defineConfig({
  site: "https://sodastech.github.io",
  base: "/rungs",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Rungs",
      description:
        "Org-aware approval workflows for TypeScript: sequential and parallel steps, delegation, deadlines, escalation and a full audit trail.",
      logo: { src: "./src/assets/rungs-icon.svg", alt: "Rungs" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Sodastech/rungs" }],
      editLink: { baseUrl: "https://github.com/Sodastech/rungs/edit/main/site/" },
      customCss: ["./src/styles/theme.css"],
      components: {
        // The release notice on every page (src/release.ts).
        Banner: "./src/components/ReleaseBanner.astro",
      },
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://sodastech.github.io/rungs/rungs-social.png",
          },
        },
      ],
      lastUpdated: true,
      plugins: [
        starlightLinksValidator({
          // Edge case anchors come from the catalog component, which the validator cannot see;
          // test/edge-cases.test.ts checks that every linked ID exists instead.
          exclude: ({ link }) => /^(?:\/rungs\/edge-cases\/)?#ec-\d+$/.test(link),
        }),
      ],
      sidebar: [
        { label: "Getting started", link: "/getting-started/" },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Edge cases", link: "/edge-cases/" },
      ],
    }),
  ],
});
