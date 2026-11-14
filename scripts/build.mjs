import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files = ['index.html', 'styles.css', 'physics.js', 'game.js', 'favicon.svg', 'manifest.webmanifest'];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')])));
const version = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
// GitHub Pages can cache individual files across deployments. Fingerprint both
// the entry assets and the module import so one page gets a consistent release.
sources['game.js'] = sources['game.js'].replace("'./physics.js'", `'./physics.js?v=${version(sources['physics.js'])}'`);
for (const file of files.filter(file => file !== 'index.html' && file !== 'physics.js')) {
  sources['index.html'] = sources['index.html'].replaceAll(`"./${file}"`, `"./${file}?v=${version(sources[file])}"`);
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) await writeFile(`dist/${file}`, sources[file]);
await writeFile('dist/.nojekyll', '');
console.log(`Built ${files.length} static assets in dist/`);
