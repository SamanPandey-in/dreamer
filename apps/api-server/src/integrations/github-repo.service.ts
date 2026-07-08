import { BadRequestError } from '../lib/errors';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Mirrors the subset of GitHub's "Get repository content" response we
 * actually use. GitHub returns extra fields (sha, size, url, html_url, etc.)
 * for every entry — we deliberately narrow to what callers need so a future
 * GitHub API response shape change can't silently leak unexpected fields
 * through to the frontend's root-directory picker.
 */
export interface RepoEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

interface GithubContentApiEntry {
  name: string;
  path: string;
  type: string; // 'file' | 'dir' | 'symlink' | 'submodule' — we only ever keep file/dir
}

interface GithubContentApiFile {
  content: string;
  encoding: string;
  type: string;
}

function buildContentsUrl(repoFullName: string, path: string, ref: string): string {
  // GitHub's contents endpoint treats a leading slash on `path` as a
  // different (invalid) route, so the root is requested with an empty
  // path segment, never "/". encodeURIComponent on each path segment
  // (not the whole path) keeps slashes as path separators while still
  // escaping spaces/special characters within a folder name.
  const encodedPath = path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

  return `${GITHUB_API_BASE}/repos/${repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
}

function githubHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' };
}

/**
 * One of the user's own GitHub repos, as shown in the wizard's "Import Git
 * Repository" list — deliberately narrower than GitHub's actual response
 * (which includes dozens of fields we don't use) for the same reason
 * RepoEntry is narrowed: a future GitHub API response shape change
 * shouldn't leak unexpected fields through to the frontend.
 */
export interface UserRepoSummary {
  fullName: string; // "owner/repo" — what every other endpoint in this file takes as repoFullName
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  updatedAt: string;
}

interface GithubUserRepoApiEntry {
  full_name: string;
  name: string;
  default_branch: string;
  private: boolean;
  updated_at: string;
}

/**
 * Lists repos the authenticated user owns or collaborates on, newest-pushed
 * first — GitHub's own default sort for this endpoint, which conveniently
 * matches what a user importing a project actually wants to see first (the
 * repo they just created or pushed to, not an alphabetical list).
 *
 * Paginates up to a fixed cap rather than fetching every page a user could
 * conceivably have — someone with 800 repos does not need all 800 rendered
 * in a picker; they need the first few screens' worth, which this comfortably
 * covers at 100 per page.
 */
export async function listUserRepos(accessToken: string): Promise<UserRepoSummary[]> {
  const MAX_PAGES = 3;
  const PER_PAGE = 100;
  const results: UserRepoSummary[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${GITHUB_API_BASE}/user/repos?sort=pushed&per_page=${PER_PAGE}&page=${page}`,
      { headers: githubHeaders(accessToken) }
    );

    if (!res.ok) {
      throw new BadRequestError('Could not list your GitHub repositories', 'GITHUB_LIST_REPOS_FAILED');
    }

    const data = (await res.json()) as GithubUserRepoApiEntry[];
    results.push(
      ...data.map((repo) => ({
        fullName: repo.full_name,
        name: repo.name,
        defaultBranch: repo.default_branch,
        isPrivate: repo.private,
        updatedAt: repo.updated_at,
      }))
    );

    if (data.length < PER_PAGE) break; // last page — no need to request an empty next one
  }

  return results;
}

/**
 * Lists the immediate children of a directory in a repo at a given ref —
 * used by the new-project wizard's root-directory picker (lazy: one call per
 * expanded folder, never a recursive full-tree fetch) and by the framework
 * detector to check for lockfiles/config files at the chosen root.
 *
 * GitHub 404s identically for "doesn't exist" and "no access" — same
 * ambiguity build-engine/clone-repo.js already documents for git itself, so
 * the error message here matches that existing tone rather than asserting
 * one cause over the other.
 */
export async function listRepoDirectory(
  accessToken: string,
  repoFullName: string,
  dirPath: string,
  ref: string
): Promise<RepoEntry[]> {
  const res = await fetch(buildContentsUrl(repoFullName, dirPath, ref), {
    headers: githubHeaders(accessToken),
  });

  if (res.status === 404) {
    throw new BadRequestError(
      `Could not find "${dirPath || '/'}" on branch "${ref}" — check the path and that your GitHub connection still has access to this repo`,
      'GITHUB_PATH_NOT_FOUND'
    );
  }

  if (!res.ok) {
    throw new BadRequestError(`GitHub returned an error listing "${dirPath || '/'}"`, 'GITHUB_LIST_FAILED');
  }

  const data = (await res.json()) as GithubContentApiEntry[] | GithubContentApiFile;

  // The contents endpoint returns an array for a directory and a single
  // object for a file — a caller that passes a file path by mistake gets a
  // clear error instead of `.filter is not a function` further down.
  if (!Array.isArray(data)) {
    throw new BadRequestError(`"${dirPath}" is a file, not a directory`, 'GITHUB_NOT_A_DIRECTORY');
  }

  return data
    .filter((entry) => entry.type === 'file' || entry.type === 'dir')
    .map((entry) => ({ name: entry.name, path: entry.path, type: entry.type as 'file' | 'dir' }))
    .sort((a, b) => {
      // Directories first, then alphabetical within each group — matches
      // the convention every file browser (Explorer, Finder, VS Code,
      // GitHub's own UI) already uses, so the root-directory picker's
      // ordering doesn't surprise anyone.
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Fetches and decodes a single file's contents. Returns null on a 404 so
 * callers (the framework detector, primarily) can treat "no package.json at
 * this path" as a normal, expected outcome rather than catching an
 * exception for it.
 */
export async function fetchRepoFile(
  accessToken: string,
  repoFullName: string,
  filePath: string,
  ref: string
): Promise<string | null> {
  const res = await fetch(buildContentsUrl(repoFullName, filePath, ref), {
    headers: githubHeaders(accessToken),
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    throw new BadRequestError(`GitHub returned an error reading "${filePath}"`, 'GITHUB_READ_FAILED');
  }

  const data = (await res.json()) as GithubContentApiFile;

  if (data.type !== 'file') {
    throw new BadRequestError(`"${filePath}" is not a file`, 'GITHUB_NOT_A_FILE');
  }

  // GitHub's contents API always base64-encodes file bodies regardless of
  // the original file's own encoding — this is the one encoding value the
  // API ever sends for a `type: "file"` entry, so anything else means the
  // API contract changed underneath us.
  if (data.encoding !== 'base64') {
    throw new BadRequestError(`Unexpected encoding "${data.encoding}" for "${filePath}"`, 'GITHUB_READ_FAILED');
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

/**
 * Convenience wrapper for the one file every detector run needs: parses
 * package.json at a given root, returning null both when the file is absent
 * AND when it exists but fails to parse (a malformed package.json should
 * degrade detection to "couldn't detect," never crash the wizard).
 */
export async function fetchPackageJson(
  accessToken: string,
  repoFullName: string,
  rootDirectory: string,
  ref: string
): Promise<Record<string, unknown> | null> {
  const path = rootDirectory ? `${rootDirectory}/package.json` : 'package.json';
  const raw = await fetchRepoFile(accessToken, repoFullName, path, ref);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // malformed JSON — detector falls back to the `static` preset, not a 500
  }
}
