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

function githubHeaders(accessToken?: string): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  // Public repo endpoints work perfectly well unauthenticated — GitHub just
  // rate-limits unauthenticated calls harder (60/hr vs. 5,000/hr). Omitting
  // the header rather than sending `Bearer undefined` is what makes
  // "browse a public repo you never granted the App access to" work at all.
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

/**
 * Lists every repo the operator's PAT can see — `GET /user/repos`,
 * authenticated, covering both public and private repos in one call. This
 * is local-engine's entire "Import Git Repository" list (see
 * docs/architecture/local-engine-auth-and-networking.md Decision 2) —
 * replaces the old per-installation repo listing entirely; there's one
 * token, and whatever it can see is the whole list.
 */
export async function listOwnRepos(accessToken: string): Promise<GithubSearchRepoEntry[]> {
  const PER_PAGE = 100;
  const res = await fetch(
    `${GITHUB_API_BASE}/user/repos?per_page=${PER_PAGE}&sort=updated&affiliation=owner,collaborator,organization_member`,
    { headers: githubHeaders(accessToken) }
  );

  if (!res.ok) {
    throw new BadRequestError('Could not list repositories for this GitHub account — check that your Personal Access Token is still valid', 'GITHUB_LIST_REPOS_FAILED');
  }

  const data = (await res.json()) as GithubSearchApiEntry[];

  return data.map((repo) => ({
    repositoryId: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    defaultBranch: repo.default_branch,
    isPrivate: repo.private,
    updatedAt: repo.updated_at,
  }));
}

/**
 * Searches GitHub's public repositories by name — the wizard's "any public
 * GitHub repo" search, useful when browsing a repo the operator's own PAT
 * doesn't own or collaborate on (so it wouldn't show up in listOwnRepos).
 * Deliberately works with NO token at all, same as before — GitHub's
 * search endpoint just rate-limits unauthenticated calls harder (60/hr vs.
 * 5,000/hr with a token attached).
 */
export async function searchPublicRepos(accessToken: string | undefined, query: string): Promise<GithubSearchRepoEntry[]> {
  const PER_PAGE = 20;
  const q = `${query} in:name is:public`;

  const res = await fetch(
    `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}`,
    { headers: githubHeaders(accessToken) }
  );

  if (!res.ok) {
    throw new BadRequestError('Could not search GitHub repositories', 'GITHUB_SEARCH_REPOS_FAILED');
  }

  const data = (await res.json()) as { items: GithubSearchApiEntry[] };

  return data.items.map((repo) => ({
    repositoryId: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    defaultBranch: repo.default_branch,
    isPrivate: repo.private,
    updatedAt: repo.updated_at,
  }));
}

interface GithubSearchApiEntry {
  id: number;
  full_name: string;
  name: string;
  default_branch: string;
  private: boolean;
  updated_at: string;
}

export interface GithubSearchRepoEntry {
  repositoryId: number;
  fullName: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  updatedAt: string;
}

interface GithubBranchApiEntry {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

/**
 * Mirrors the subset of a GitHub branch we surface — used by both the
 * new-project wizard's branch picker and the project-settings "Production
 * Branch" dropdown, so a repo's branch list is fetched the same way and in
 * the same shape regardless of which screen asked for it.
 */
export interface RepoBranch {
  name: string;
  isDefault: boolean;
}

/**
 * Lists a repo's branches — GitHub doesn't sort branches by activity the way
 * it does repos/PRs, so this returns whatever order the API gives
 * (alphabetical in practice) with the repo's default branch flagged so
 * callers can float it to the top of a dropdown instead of leaving it
 * wherever it happens to sort.
 *
 * Capped at one page — a branch picker for a repo
 * with 100+ branches is a rare enough case that "show the first 100,
 * default branch included" is a reasonable limit rather than something
 * worth paginating.
 */
export async function listBranches(
  accessToken: string | undefined,
  repoFullName: string,
  defaultBranch: string
): Promise<RepoBranch[]> {
  const PER_PAGE = 100;
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${repoFullName}/branches?per_page=${PER_PAGE}`,
    { headers: githubHeaders(accessToken) }
  );

  if (res.status === 404) {
    throw new BadRequestError(
      `Could not find repository "${repoFullName}" — check that it exists and your GitHub connection has access to it`,
      'GITHUB_REPO_NOT_FOUND'
    );
  }

  if (!res.ok) {
    throw new BadRequestError('Could not list branches for this repository', 'GITHUB_LIST_BRANCHES_FAILED');
  }

  const data = (await res.json()) as GithubBranchApiEntry[];

  return data
    .map((branch) => ({ name: branch.name, isDefault: branch.name === defaultBranch }))
    .sort((a, b) => {
      // Default branch first, then alphabetical — matches the same
      // "put the obvious choice at the top" convention listRepoDirectory
      // already uses for directories-before-files.
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
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
  accessToken: string | undefined,
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
  accessToken: string | undefined,
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
  accessToken: string | undefined,
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
