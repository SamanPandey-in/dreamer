import type { DeploymentType, Framework } from '../generated/prisma/client';

/**
 * Internal identifier for a detectable framework — one row per entry in the
 * PRESETS table below. Deliberately distinct from the Prisma `Framework`
 * enum: this id space is allowed to grow (e.g. splitting "vite" into
 * "vite-react" / "vite-vue" later) without a migration, because mapping onto
 * the DB enum happens in exactly one place.
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
    /** Maps onto Prisma's DeploymentType enum — STATIC ships static files to the object store, DYNAMIC needs a long-running container. */
    deploymentType: DeploymentType;
    frameworkEnum: Framework;
    defaultInstallCommand: string;
    defaultBuildCommand: string;
    defaultOutputDirectory: string;

    /**
     * True for frameworks whose output needs a runtime this platform cannot
     * serve correctly today (a long-running Node process, not a folder of
     * static files). The wizard surfaces this as a blocking notice rather
     * than silently producing a deployment that 404s on every route.
     */
    requiresUnsupportedRuntime: boolean;
}

/**
 * Order carries no meaning — detection priority lives in
 * framework-detector.ts. This table only answers "given a preset id, what
 * are its defaults," which is also what the wizard consults when the user
 * manually changes the Application Preset dropdown.
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
    // Real Angular CLI output nests under dist/<project-name>, unknowable
    // without parsing angular.json — left for the user to confirm/correct
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
