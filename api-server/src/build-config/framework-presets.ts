import type { DeploymentType, Framework } from '../generated/prisma/client';

/**
 * Internal identifier for a detectable framework — one row per entry in the
 * PRESETS table below. Deliberately distinct from the Prisma `Framework`
 * enum: this id space is allowed to grow (e.g. splitting "vite" into
 * "vite-react" / "vite-vue" later) without a migration, because
 * `frameworkPresetIdToEnum` is the one place that maps it onto the DB enum.
 */
export type FrameworkPresetId = 
  | 'nextjs-ssr'
  | 'nextjs-static'
  | 'vite'
  | 'cra'
  | 'angular'
  | 'gatsby'
  | 'sveltekit'
  | 'astro'
  | 'nuxt'
  | 'vue-cli'
  | 'static';

export interface FrameworkPreset {
    id: FrameworkPresetId;
    /** Human-readable name shown in the wizard's "Application Preset" dropdown. */
    label: string;
    /** Maps onto Prisma's DeploymentType enum — STATIC ships to S3, DYNAMIC needs a long-running container build-engine does not implement yet. */
    deploymentType: DeploymentType;
    frameworkEnum: Framework;
    defaultInstallCommand: string;
    defaultBuildCommand: string;
    defaultOutputDirectory: string;

    /**
   * True for frameworks build-engine's current S3-static pipeline cannot
   * serve correctly today (e.g. a default Next.js SSR build needs a
   * long-running Node process, not a folder of static files). The wizard
   * surfaces this as a blocking notice rather than silently producing a
   * deployment that uploads to S3 and 404s on every route.
   */
    requiresUnsupportedRuntime: boolean;
}

/**
 * Ordered by nothing in particular — order of detection priority lives in
 * framework-detector.ts, not here. This table only answers "given a preset
 * id, what are its defaults," which is also exactly what the wizard calls
 * when the user manually changes the Application Preset dropdown to
 * something other than what was auto-detected.
 */
export const FRAMEWORK_PRESETS: Record<FrameworkPresetId, FrameworkPreset> = {
  'nextjs-static': {
    id: 'nextjs-static',
    label: 'Next.js (static export)',
    deploymentType: 'STATIC',
    frameworkEnum: 'NEXT_STATIC',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: 'out',
    requiresUnsupportedRuntime: false,
  },
  'nextjs-ssr': {
    id: 'nextjs-ssr',
    label: 'Next.js',
    deploymentType: 'DYNAMIC',
    frameworkEnum: 'NEXT_SSR',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: '.next',
    // CHANGED — was true. Next.js SSR now actually deploys, on the
    // container-based DYNAMIC runtime — see deployDynamicApp() in
    // deployment-engine.ts and docs/How-I-built-it.md. The requirement
    // this preset can't express here (next.config.js needs
    // `output: 'standalone'`) is checked instead at build time by
    // build-engine's dockerfile-resolver.js, which warns in the build
    // logs rather than blocking the deploy outright — a text-search check
    // against the repo's config file is reliable enough to warn on, not
    // reliable enough to hard-block a deploy on a false positive.
    requiresUnsupportedRuntime: false,
  },
  vite: {
    id: 'vite',
    label: 'Vite',
    deploymentType: 'STATIC',
    frameworkEnum: 'REACT_VITE',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: 'dist',
    requiresUnsupportedRuntime: false,
  },
  cra: {
    id: 'cra',
    label: 'Create React App',
    deploymentType: 'STATIC',
    frameworkEnum: 'REACT_CRA',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: 'build',
    requiresUnsupportedRuntime: false,
  },
  angular: {
    id: 'angular',
    label: 'Angular',
    deploymentType: 'STATIC',
    frameworkEnum: 'STATIC_HTML',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    // Real Angular CLI output nests under dist/<project-name>, which we
    // can't know without parsing angular.json — outputDirectory is
    // deliberately left for the user to confirm/correct in the wizard
    // rather than guessing a project-name segment we don't have.
    defaultOutputDirectory: 'dist',
    requiresUnsupportedRuntime: false,
  },
  gatsby: {
    id: 'gatsby',
    label: 'Gatsby',
    deploymentType: 'STATIC',
    frameworkEnum: 'STATIC_HTML',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: 'public',
    requiresUnsupportedRuntime: false,
  },
  sveltekit: {
    id: 'sveltekit',
    label: 'SvelteKit (static)',
    deploymentType: 'STATIC',
    frameworkEnum: 'SVELTE',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: 'build',
    requiresUnsupportedRuntime: false,
  },
  astro: {
    id: 'astro',
    label: 'Astro',
    deploymentType: 'STATIC',
    frameworkEnum: 'STATIC_HTML',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: 'dist',
    requiresUnsupportedRuntime: false,
  },
  nuxt: {
    id: 'nuxt',
    label: 'Nuxt',
    deploymentType: 'DYNAMIC',
    frameworkEnum: 'VUE',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: '.output/public',
    requiresUnsupportedRuntime: true,
  },
  'vue-cli': {
    id: 'vue-cli',
    label: 'Vue',
    deploymentType: 'STATIC',
    frameworkEnum: 'VUE',
    defaultInstallCommand: 'npm install',
    defaultBuildCommand: 'npm run build',
    defaultOutputDirectory: 'dist',
    requiresUnsupportedRuntime: false,
  },
  static: {
    id: 'static',
    label: 'Other',
    deploymentType: 'STATIC',
    frameworkEnum: 'STATIC_HTML',
    defaultInstallCommand: '',
    defaultBuildCommand: '',
    defaultOutputDirectory: '.',
    requiresUnsupportedRuntime: false,
  },
};

export function getPresetById(id: FrameworkPresetId): FrameworkPreset {
  return FRAMEWORK_PRESETS[id];
}

export function listAllPresets(): FrameworkPreset[] {
  return Object.values(FRAMEWORK_PRESETS);
}

/** Public-facing shape for the wizard's "Application Preset" dropdown — omits requiresUnsupportedRuntime's sibling internals the frontend doesn't act on directly (it gets that flag from the /detect response instead, scoped to the repo actually being imported). */
export interface PublicFrameworkPreset {
  id: FrameworkPresetId;
  label: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
}

export function listPublicPresets(): PublicFrameworkPreset[] {
  return listAllPresets().map((preset) => ({
    id: preset.id,
    label: preset.label,
    installCommand: preset.defaultInstallCommand,
    buildCommand: preset.defaultBuildCommand,
    outputDirectory: preset.defaultOutputDirectory,
  }))
}
