import { FRAMEWORK_PRESETS, type FrameworkPreset, type FrameworkPresetId } from './framework-presets';

export interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface DetectionInput {
  /** Filenames (not full paths) present at the chosen root directory. */
  rootFiles: readonly string[];
  /** Parsed package.json at the root directory, or null if absent/unparseable. */
  packageJson: PackageJsonShape | null;
}

export interface DetectionResult {
  preset: FrameworkPreset;
  /**
   * What actually matched, for surfacing in the UI ("Detected via
   * next.config.js" rather than just "Detected: Next.js") and for
   * detection-quality telemetry/debugging later — knowing whether real
   * repos are being caught by the config-file check or falling through to
   * the dependency check is useful information this result shouldn't throw
   * away just because the caller doesn't need it today.
   */
  matchedOn: string | null;
}

const STATIC_PRESET = FRAMEWORK_PRESETS.static;

function hasAnyDependency(pkg: PackageJsonShape | null, ...names: string[]): boolean {
    if (!pkg) return false;
    return names.some((name) => Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]));
}

function hasFile(rootFiles: readonly string[], ...names: string[]): string | null {
  return names.find((name) => rootFiles.includes(name)) ?? null;
}

/**
 * Next.js is the one framework on this list that can't be resolved to a
 * single FrameworkPreset from config-file/dependency presence alone — the
 * SAME next.config.js can produce either a static export (output: 'export')
 * or a standard SSR build, and only the former is servable by build-engine's
 * current S3-static pipeline. We resolve this by inspecting the config
 * file's source for the `output: 'export'` literal.
 *
 * This is intentionally a plain substring/regex check, not a JS/TS parse —
 * next.config.js can be CJS, ESM, or TS, and a full parse for one config
 * key is more failure surface than this feature needs. A config that sets
 * `output` dynamically (e.g. from an env var) won't be caught by this
 * check; that's an acceptable false negative — it falls through to the
 * nextjs-ssr preset, which is the safer default since it surfaces the
 * "this needs a different deploy type" notice instead of silently
 * misconfiguring a static deploy that won't actually work.
 */
function isNextStaticExport(nextConfigSource: string | null): boolean {
  if (!nextConfigSource) return false;
  return /output\s*:\s*['"]export['"]/.test(nextConfigSource);
}

export interface NextConfigLookup {
  /** The matched config filename (e.g. "next.config.js"), or null if none exists. */
  filename: string | null;
  /** That file's source text, or null if it doesn't exist / wasn't fetched. */
  source: string | null;
}

/**
 * Detects which FrameworkPreset best matches a repo, checking signals in
 * order of reliability (strongest first, per the detection guide):
 *
 *   1. A framework-specific config file at the root — can't lie about what
 *      build tool is actually wired up, regardless of what's listed in
 *      package.json.
 *   2. package.json dependencies/devDependencies — reliable but slightly
 *      weaker (a config file can exist without the dependency listed in an
 *      unusual monorepo hoisting setup, and vice versa for a leftover dep).
 *   3. No match -> the `static` preset, an explicit "we don't know, ask the
 *      user" rather than a wrong guess dressed up as a confident answer.
 *
 * `nextConfig` is optional and fetched separately by the caller (only when
 * a next.config.* file is found) — keeping the static-export sub-check out
 * of this function's required inputs means every other branch stays a pure,
 * synchronous decision with zero I/O.
 */
export function detectFramework(input: DetectionInput, nextConfig?: NextConfigLookup): DetectionResult {
  const { rootFiles, packageJson } = input;

  // 1. Config files — strongest signal, checked first.
  const nextConfigFile = nextConfig?.filename ?? hasFile(rootFiles, 'next.config.js', 'next.config.ts', 'next.config.mjs');
  if (nextConfigFile) {
    const isStaticExport = isNextStaticExport(nextConfig?.source ?? null);
    return {
      preset: FRAMEWORK_PRESETS[isStaticExport ? 'nextjs-static' : 'nextjs-ssr'],
      matchedOn: nextConfigFile,
    };
  }

  const viteConfigFile = hasFile(rootFiles, 'vite.config.js', 'vite.config.ts', 'vite.config.mjs');
  if (viteConfigFile) return { preset: FRAMEWORK_PRESETS.vite, matchedOn: viteConfigFile };

  const angularConfigFile = hasFile(rootFiles, 'angular.json');
  if (angularConfigFile) return { preset: FRAMEWORK_PRESETS.angular, matchedOn: angularConfigFile };

  const gatsbyConfigFile = hasFile(rootFiles, 'gatsby-config.js', 'gatsby-config.ts');
  if (gatsbyConfigFile) return { preset: FRAMEWORK_PRESETS.gatsby, matchedOn: gatsbyConfigFile };

  const svelteConfigFile = hasFile(rootFiles, 'svelte.config.js');
  if (svelteConfigFile) return { preset: FRAMEWORK_PRESETS.sveltekit, matchedOn: svelteConfigFile };

  const astroConfigFile = hasFile(rootFiles, 'astro.config.mjs', 'astro.config.ts', 'astro.config.js');
  if (astroConfigFile) return { preset: FRAMEWORK_PRESETS.astro, matchedOn: astroConfigFile };

  const nuxtConfigFile = hasFile(rootFiles, 'nuxt.config.js', 'nuxt.config.ts');
  if (nuxtConfigFile) return { preset: FRAMEWORK_PRESETS.nuxt, matchedOn: nuxtConfigFile };

  // 2. package.json dependencies — fallback for repos with no recognized config file.
  if (hasAnyDependency(packageJson, 'next')) {
    // No next.config.* was found above, so we can't inspect for a static
    // export flag — default to the SSR preset, which is the conservative
    // choice (surfaces the unsupported-runtime notice rather than assuming
    // static behavior we have no evidence for).
    return { preset: FRAMEWORK_PRESETS['nextjs-ssr'], matchedOn: 'package.json (next dependency)' };
  }
  if (hasAnyDependency(packageJson, 'vite')) {
    return { preset: FRAMEWORK_PRESETS.vite, matchedOn: 'package.json (vite dependency)' };
  }
  if (hasAnyDependency(packageJson, 'react-scripts')) {
    return { preset: FRAMEWORK_PRESETS.cra, matchedOn: 'package.json (react-scripts dependency)' };
  }
  if (hasAnyDependency(packageJson, '@angular/core')) {
    return { preset: FRAMEWORK_PRESETS.angular, matchedOn: 'package.json (@angular/core dependency)' };
  }
  if (hasAnyDependency(packageJson, 'gatsby')) {
    return { preset: FRAMEWORK_PRESETS.gatsby, matchedOn: 'package.json (gatsby dependency)' };
  }
  if (hasAnyDependency(packageJson, '@sveltejs/kit')) {
    return { preset: FRAMEWORK_PRESETS.sveltekit, matchedOn: 'package.json (@sveltejs/kit dependency)' };
  }
  if (hasAnyDependency(packageJson, 'astro')) {
    return { preset: FRAMEWORK_PRESETS.astro, matchedOn: 'package.json (astro dependency)' };
  }
  if (hasAnyDependency(packageJson, 'nuxt', 'nuxt3')) {
    return { preset: FRAMEWORK_PRESETS.nuxt, matchedOn: 'package.json (nuxt dependency)' };
  }
  if (hasAnyDependency(packageJson, 'vue') && hasAnyDependency(packageJson, '@vue/cli-service')) {
    return { preset: FRAMEWORK_PRESETS['vue-cli'], matchedOn: 'package.json (@vue/cli-service dependency)' };
  }

  // 3. Nothing matched.
  return { preset: STATIC_PRESET, matchedOn: null };
}

/** Whether a next.config.* lookup is needed before calling detectFramework, given a root file listing. Lets the caller skip the extra file fetch entirely for repos that obviously aren't Next.js. */
export function needsNextConfigSource(rootFiles: readonly string[]): string | null {
  return hasFile(rootFiles, 'next.config.js', 'next.config.ts', 'next.config.mjs');
}

export type { FrameworkPreset, FrameworkPresetId };
