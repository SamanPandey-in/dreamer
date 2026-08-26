import '../../setup/test-env';
import { describe, it, expect } from 'vitest';
import { detectFramework, needsNextConfigSource } from '@api/build-config/framework-detector';
import { loadRepoFixture } from '../../fixtures/load-repo-fixture';

describe('detectFramework — demo dynamic repo (Next.js)', () => {
  it('detects a Next.js repo with output: "standalone" as the DYNAMIC nextjs-ssr preset', () => {
    const { detectionInput, nextConfig } = loadRepoFixture('nextjs-dynamic');

    const result = detectFramework(detectionInput, nextConfig);

    expect(result.preset.id).toBe('nextjs-ssr');
    expect(result.preset.deploymentType).toBe('DYNAMIC');
    expect(result.preset.frameworkEnum).toBe('NEXT_SSR');
    expect(result.preset.requiresUnsupportedRuntime).toBe(false);
    expect(result.matchedOn).toBe('next.config.js');
  });

  it('flags needsNextConfigSource so the caller knows to fetch next.config.js before detecting', () => {
    const { rootFiles } = loadRepoFixture('nextjs-dynamic');
    expect(needsNextConfigSource(rootFiles)).toBe('next.config.js');
  });

  it('falls back to the conservative nextjs-ssr preset via the package.json dependency check when no next.config.* file is present at all', () => {
    const result = detectFramework({
      rootFiles: ['package.json', 'pages', 'public'],
      packageJson: { dependencies: { next: '14.2.5', react: '18.3.1', 'react-dom': '18.3.1' } },
    });

    expect(result.preset.id).toBe('nextjs-ssr');
    expect(result.preset.deploymentType).toBe('DYNAMIC');
    expect(result.matchedOn).toBe('package.json (next dependency)');
  });

  it('a next.config.* file present but unfetched (source not looked up) still resolves to nextjs-ssr, not a guessed static export', () => {
    const { detectionInput } = loadRepoFixture('nextjs-dynamic');

    const result = detectFramework(detectionInput);

    expect(result.preset.id).toBe('nextjs-ssr');
    expect(result.preset.deploymentType).toBe('DYNAMIC');
    expect(result.matchedOn).toBe('next.config.js');
  });

  it('detects Next.js with output: "export" as the STATIC nextjs-static preset, not DYNAMIC', () => {
    const { detectionInput, nextConfig } = loadRepoFixture('nextjs-static-export');

    const result = detectFramework(detectionInput, nextConfig);

    expect(result.preset.id).toBe('nextjs-static');
    expect(result.preset.deploymentType).toBe('STATIC');
    expect(result.preset.frameworkEnum).toBe('NEXT_STATIC');
    expect(result.preset.defaultOutputDirectory).toBe('out');
  });
});

describe('detectFramework — demo static repo (React)', () => {
  it('detects a React + Vite repo via vite.config.ts as the STATIC vite preset', () => {
    const { detectionInput } = loadRepoFixture('react-vite');

    const result = detectFramework(detectionInput);

    expect(result.preset.id).toBe('vite');
    expect(result.preset.deploymentType).toBe('STATIC');
    expect(result.preset.frameworkEnum).toBe('REACT_VITE');
    expect(result.preset.defaultOutputDirectory).toBe('dist');
    expect(result.matchedOn).toBe('vite.config.ts');
  });

  it('detects a Create React App repo (react-scripts, no config file) as the STATIC cra preset', () => {
    const { detectionInput } = loadRepoFixture('react-cra');

    const result = detectFramework(detectionInput);

    expect(result.preset.id).toBe('cra');
    expect(result.preset.deploymentType).toBe('STATIC');
    expect(result.preset.frameworkEnum).toBe('REACT_CRA');
    expect(result.preset.defaultOutputDirectory).toBe('build');
    expect(result.matchedOn).toBe('package.json (react-scripts dependency)');
  });

  it('config-file signal wins over a stale/misleading dependency: Vite config beats a leftover CRA-shaped script', () => {
    const detectionInput = {
      rootFiles: ['vite.config.ts', 'package.json'],
      packageJson: {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        devDependencies: { 'react-scripts': '5.0.1', vite: '5.3.4' },
      },
    };

    const result = detectFramework(detectionInput);

    expect(result.preset.id).toBe('vite');
    expect(result.matchedOn).toBe('vite.config.ts');
  });
});

describe('detectFramework — repos with no recognizable framework', () => {
  it('falls back to the static/"Other" preset for a plain HTML/no-dependency repo', () => {
    const { detectionInput } = loadRepoFixture('no-framework');

    const result = detectFramework(detectionInput);

    expect(result.preset.id).toBe('static');
    expect(result.preset.deploymentType).toBe('STATIC');
    expect(result.matchedOn).toBeNull();
  });

  it('falls back to the static preset when packageJson is entirely absent', () => {
    const result = detectFramework({ rootFiles: ['index.html', 'style.css'], packageJson: null });

    expect(result.preset.id).toBe('static');
    expect(result.matchedOn).toBeNull();
  });
});

describe('detectFramework — other framework config-file signals', () => {
  it('detects Angular via angular.json ahead of any dependency check', () => {
    const result = detectFramework({
      rootFiles: ['angular.json', 'package.json'],
      packageJson: { dependencies: { '@angular/core': '17.0.0' } },
    });
    expect(result.preset.id).toBe('angular');
    expect(result.matchedOn).toBe('angular.json');
  });

  it('detects SvelteKit via svelte.config.js', () => {
    const result = detectFramework({
      rootFiles: ['svelte.config.js'],
      packageJson: { devDependencies: { '@sveltejs/kit': '2.5.0' } },
    });
    expect(result.preset.id).toBe('sveltekit');
    expect(result.preset.deploymentType).toBe('STATIC');
  });

  it('detects Nuxt via nuxt.config.ts and correctly flags it as requiring an unsupported runtime', () => {
    const result = detectFramework({ rootFiles: ['nuxt.config.ts'], packageJson: null });
    expect(result.preset.id).toBe('nuxt');
    expect(result.preset.deploymentType).toBe('DYNAMIC');
    expect(result.preset.requiresUnsupportedRuntime).toBe(true);
  });
});
