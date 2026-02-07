import { Errors } from "../middleware/error-handler.js";

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  "http://localhost:3001/api/auth/google/callback";

// Discord OAuth
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI ||
  "http://localhost:3001/api/auth/discord/callback";

export interface OAuthUser {
  id: string;
  email: string;
  name: string;
  avatar?: string;
}

// ============================================================================
// Google
// ============================================================================

export function getGoogleAuthUrl(): string {
  if (!GOOGLE_CLIENT_ID) {
    throw Errors.BadRequest("Google OAuth no configurado");
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function getGoogleUserFromCode(code: string): Promise<OAuthUser> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw Errors.BadRequest("Google OAuth no configurado");
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw Errors.BadRequest("Error al obtener token de Google");
  }

  const tokens = (await tokenRes.json()) as { access_token: string };

  // Fetch user info
  const userRes = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  );

  if (!userRes.ok) {
    throw Errors.BadRequest("Error al obtener informacion de Google");
  }

  const userData = (await userRes.json()) as {
    id: string;
    email: string;
    name: string;
    picture?: string;
  };

  return {
    id: userData.id,
    email: userData.email,
    name: userData.name,
    avatar: userData.picture,
  };
}

// ============================================================================
// Discord
// ============================================================================

export function getDiscordAuthUrl(): string {
  if (!DISCORD_CLIENT_ID) {
    throw Errors.BadRequest("Discord OAuth no configurado");
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify email",
  });

  return `https://discord.com/api/oauth2/authorize?${params}`;
}

export async function getDiscordUserFromCode(
  code: string,
): Promise<OAuthUser> {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    throw Errors.BadRequest("Discord OAuth no configurado");
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      redirect_uri: DISCORD_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw Errors.BadRequest("Error al obtener token de Discord");
  }

  const tokens = (await tokenRes.json()) as { access_token: string };

  // Fetch user info
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    throw Errors.BadRequest("Error al obtener informacion de Discord");
  }

  const userData = (await userRes.json()) as {
    id: string;
    email: string;
    username: string;
    avatar?: string;
  };

  return {
    id: userData.id,
    email: userData.email,
    name: userData.username,
    avatar: userData.avatar
      ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
      : undefined,
  };
}
