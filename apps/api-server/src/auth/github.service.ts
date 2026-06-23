import { env } from '../lib/env';
import { BadRequestError } from '../lib/errors';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';

export interface GithubProfile {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string;
}

interface GithubEmail {
    email: string;
    primary: boolean;
    verified: boolean;
}

/** Step 1 of the OAuth dance — where we send the browser to ask the user for consent. */
export function buildGithubAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        redirect_uri: env.GITHUB_CALLBACK_URL,
        scope: 'read:user user:email repo',
        state,
        allow_signup: 'true',
    });

    return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/** Step 2 — exchange the short-lived `code` GitHub redirected back with, for an access token. */
export async function exchangeCodeForToken(code: string): Promise<string> {
    const response = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: env.GITHUB_CALLBACK_URL,
        }),
    });

    const data = (await response.json()) as { access_token?: string; error?: string };

    if (!response.ok || !data.access_token) {
        throw new BadRequestError(
            `GitHub token exchange failed: ${data.error ?? 'unknown error'}`,
            'GITHUB_AUTH_FAILED'
        );
    }

    return data.access_token;
}

/** Step 3 — fetch the GitHub profile of the user who just authorized us. */
export async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) {
        throw new BadRequestError('Failed to fetch GitHub profile', 'GITHUB_AUTH_FAILED');
    }

    return response.json() as Promise<GithubProfile>;
}

/**
 * GitHub's primary email can be private — /user omits it in that case, so we
 * need the dedicated /user/emails endpoint (requires the `user:email` scope).
 *
 * We only ever return a VERIFIED email. A verified email is the one safe
 * signal we can use to auto-link a GitHub login to an existing password
 * account — an unverified email could be typed in by anyone and doesn't
 * prove ownership of that inbox.
 */
export async function fetchPrimaryVerifiedGithubEmail(accessToken: string): Promise<string | null> {
    const response = await fetch(`${GITHUB_API_BASE}/user/emails`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) return null;

    const emails = (await response.json()) as GithubEmail[];
    const primary = emails.find((e) => e.primary && e.verified);

    return primary?.email ?? null;
}