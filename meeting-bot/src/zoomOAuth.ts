export type OAuthCredentials = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
};

export type OAuthTokenRefreshResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  tokenType: string | null;
};

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export async function refreshOAuthAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<OAuthTokenRefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    reason?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.reason ||
        payload.error ||
        `Zoom OAuth refresh failed with HTTP ${response.status}`,
    );
  }
  const exchangedAt = Date.now();
  const expiresAt =
    typeof payload.expires_in === "number"
      ? new Date(exchangedAt + payload.expires_in * 1000).toISOString()
      : null;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    expiresAt,
    scope: payload.scope ?? null,
    tokenType: payload.token_type ?? null,
  };
}

export async function fetchZoomUserZak(accessToken: string): Promise<{
  token: string;
  expiresIn: number | null;
}> {
  const response = await fetch("https://api.zoom.us/v2/users/me/zak", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    token?: string;
    expires_in?: number;
    message?: string;
    code?: number;
  };
  if (!response.ok || !payload.token) {
    throw new Error(
      payload.message ||
        `Zoom ZAK request failed with HTTP ${response.status}`,
    );
  }
  return {
    token: payload.token,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : null,
  };
}

export function oauthScopesIncludeZak(scope: string | null | undefined): boolean {
  if (!scope) return false;
  const parts = scope.split(/\s+/u);
  return parts.includes("user:read:zak") || parts.includes("user:read:token");
}
