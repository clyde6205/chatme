#!/usr/bin/env node
// Guards the permanent Android application id. `pro.chatme.app` is the Play Store
// identity: changing it creates a different app, and existing installs cannot update.
// Do not change ANDROID_ID without explicit authorization from the product owner.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ANDROID_ID = 'pro.chatme.app';
const root = join(import.meta.dirname, '..', 'apps', 'mobile');
const problems = [];

const appJson = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
if (appJson.expo?.android?.package !== ANDROID_ID) problems.push(`app.json expo.android.package is "${appJson.expo?.android?.package}"`);

const gradle = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf8');
for (const key of ['namespace', 'applicationId']) {
  const m = new RegExp(`${key}\\s+["']([^"']+)["']`).exec(gradle);
  if (m?.[1] !== ANDROID_ID) problems.push(`build.gradle ${key} is "${m?.[1]}"`);
}

const srcRoot = join(root, 'android', 'app', 'src', 'main', 'java');
const expectedDir = join(srcRoot, ...ANDROID_ID.split('.'));
if (!existsSync(expectedDir)) problems.push(`Kotlin sources are not under ${expectedDir}`);
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const file of walk(srcRoot).filter((f) => /\.(kt|java)$/.test(f))) {
  const pkg = /^package\s+([\w.]+)/m.exec(readFileSync(file, 'utf8'))?.[1];
  if (pkg !== ANDROID_ID && !pkg?.startsWith(`${ANDROID_ID}.`)) problems.push(`${file} declares package ${pkg}`);
}

if (problems.length) {
  console.error(`Android application id must be ${ANDROID_ID}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Android application id: ${ANDROID_ID} (app.json, Gradle, Kotlin sources agree)`);
