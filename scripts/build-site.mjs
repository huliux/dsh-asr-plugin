import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { googleSiteVerification, locales, screenshots } from '../site/content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv[2];
if (!outputArg || !isAbsolute(outputArg)) throw new Error('Pass a new absolute output directory outside the checkout.');
const output = resolve(outputArg);
const relativeOutput = relative(root, output);
if (!relativeOutput.startsWith(`..${sep}`)) throw new Error('Site output must be outside the checkout.');
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite an existing site or unrelated files.
await mkdir(resolve(output, 'assets'));
await mkdir(resolve(output, 'en'));
await mkdir(resolve(output, 'zh-CN'));

const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const base = 'https://huliux.github.io/dsh-asr-plugin/';
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const route = (key) => key === 'index' ? '' : `${key}.html`;
const generated = [];
const siteUrls = [];

for (const [language, locale] of Object.entries(locales)) {
  for (const [key, page] of Object.entries(locale.pages)) {
    const path = `${locale.prefix}${key}.html`;
    const rootPath = locale.prefix ? '../' : './';
    const url = `${base}${locale.prefix}${route(key)}`;
    const alternate = `${rootPath}${locale.other}${route(key) || './'}`;
    const nav = Object.entries(locale.nav).map(([target, label]) => `<a href="${route(target) || './'}"${target === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    const body = page.body.replaceAll('{{root}}', rootPath).replaceAll('{{version}}', version)
      .replace('<h2>录音时，也能整理当前要点</h2>', '<h2 id="live-example">录音时，也能整理当前要点</h2>')
      .replace('<h2>Summarize what has been said so far</h2>', '<h2 id="live-example">Summarize what has been said so far</h2>');
    const html = `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)} · dsh-asr-plugin</title>
<meta name="description" content="${escape(page.description)}">
${key === 'index' && locale.prefix === '' ? `<meta name="google-site-verification" content="${escape(googleSiteVerification)}" />` : ''}
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="zh-CN" href="${base}${locales['zh-CN'].prefix}${route(key)}">
<link rel="alternate" hreflang="en" href="${base}${locales.en.prefix}${route(key)}">
<link rel="alternate" hreflang="x-default" href="${base}${route(key)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escape(page.title)} · dsh-asr-plugin">
<meta property="og:description" content="${escape(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${base}assets/recording-live-summary.jpg">
<meta property="og:locale" content="${language === 'en' ? 'en_US' : 'zh_CN'}">
<link rel="stylesheet" href="${rootPath}style.css">
<script src="${rootPath}copy.js" defer></script>
</head>
<body>
<a class="skip" href="#content">${locale.skip}</a>
<div class="page">
<header><p class="identity"><a href="./">dsh-asr-plugin</a><br><span class="muted">${locale.tagline}</span></p>
<nav aria-label="${language === 'en' ? 'Main navigation' : '主导航'}">${nav}<a href="${alternate}" lang="${language === 'en' ? 'zh-CN' : 'en'}" hreflang="${language === 'en' ? 'zh-CN' : 'en'}">${locale.otherLabel}</a></nav></header>
<main id="content"><h1>${page.title}</h1>${body}</main>
<footer><p>${locale.footer}</p></footer>
</div>
</body>
</html>
`;
    await writeFile(resolve(output, path), html);
    generated.push({ path, html });
    siteUrls.push(url);
  }
}

// Keep the first published English URLs working after English moves to the root.
for (const key of Object.keys(locales.en.pages)) {
  const target = `../${route(key) || './'}`;
  const path = `en/${key}.html`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page moved · dsh-asr-plugin</title><link rel="canonical" href="${base}${route(key)}">
<meta http-equiv="refresh" content="0; url=${target}"></head>
<body><p><a href="${target}">Continue to the English page</a>.</p></body></html>\n`;
  await writeFile(resolve(output, path), html);
  generated.push({ path, html });
}

for (const name of ['style.css', 'copy.js']) await copyFile(resolve(root, 'site', name), resolve(output, name));
for (const name of screenshots) await copyFile(resolve(root, 'assets/screenshots', `${name}.jpg`), resolve(output, 'assets', `${name}.jpg`));
await writeFile(resolve(output, '.nojekyll'), '');
await writeFile(resolve(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${siteUrls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}\n</urlset>\n`);

// Check the public output boundary, including language links and image targets.
for (const { path, html } of generated) {
  if (html.includes('{{')) throw new Error(`Unresolved template in ${path}`);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(?:https:|mailto:)/.test(target)) continue;
    const [file, fragment] = target.split('#');
    let destination = resolve(output, dirname(path), file || path.split('/').at(-1));
    if (destination !== output && !destination.startsWith(`${output}${sep}`)) throw new Error(`Link outside site: ${target}`);
    if ((await stat(destination)).isDirectory()) destination = resolve(destination, 'index.html');
    await stat(destination);
    if (fragment && !(await readFile(destination, 'utf8')).includes(`id="${fragment}"`)) throw new Error(`Missing anchor: ${path} → ${target}`);
  }
}
console.log(`Built and checked ${generated.length} pages for ${version}: ${output}`);
