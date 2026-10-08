# Project site maintenance

The public project site is hosted with GitHub Pages at
<https://huliux.github.io/dsh-asr-plugin/> (Chinese) and
<https://huliux.github.io/dsh-asr-plugin/en/> (English).
Each language has an introduction, installation guide, workflows and FAQ.

The visual direction follows the narrow single-column typography and whitespace
of [Emil Kowalski's skill page](https://emilkowal.ski/skill). No source, fonts or
branding from that site are included. Use ordinary text links, small headings,
plain commands and unedited product screenshots.

## Build and preview

Use Node.js 24. No site dependencies or plugin/native build are required:

```sh
pnpm run build:site /absolute/path/to/new-site-directory
```

The directory must be new and outside the checkout; existing output is never
overwritten. Serve that directory with a local static server for visual review.
Do not commit the generated HTML or preview artifacts.

- `content.mjs`: bilingual content and explicit public screenshot selection.
- `style.css`: shared responsive layout; use system fonts, white background and
  restrained grayscale text. Keep screenshots in their original colors.
- `copy.js`: optional copy-command enhancement; content works without JavaScript.
- `../scripts/build-site.mjs`: generates HTML, canonical and language alternate
  links, sharing metadata and sitemap; validates local links and anchors.

Installation commands use the root package version. Keep the source version and
published stable version aligned before a site deployment. Demo captions record
the actual tested versions separately; do not silently change historical evidence.
Check feature, compatibility and privacy claims against the public README.

## Deployment and search

`.github/workflows/pages.yml` builds selected site inputs on pushes to `main`
and manual dispatch, then deploys through the `github-pages` environment.
It does not upload the repository, model weights, package binaries or user data.
Only the eight HTML pages, CSS/JavaScript, four selected screenshots, sitemap and
`.nojekyll` are published. Actions are pinned to reviewed commit hashes.

Pages is configured to use GitHub Actions. Repository About and package homepage
point to the project site. Updating source metadata does not modify a previously
published npm version; carry it into the next qualified release.

The sitemap is <https://huliux.github.io/dsh-asr-plugin/sitemap.xml>.
For Google Search Console, verify this URL-prefix property with its supplied HTML
meta tag or verification file and submit the sitemap. Verification needs the
maintainer's Search Console account; deployment alone does not perform it or
guarantee indexing. The site includes no analytics or tracking scripts.
