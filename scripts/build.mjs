import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
const files = ['index.html', 'styles.css', 'physics.js', 'game.js', 'favicon.svg', 'manifest.webmanifest'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) await cp(file, `dist/${file}`);
await writeFile('dist/.nojekyll', '');
console.log(`Built ${files.length} static assets in dist/`);
