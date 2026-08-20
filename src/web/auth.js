// Discord OAuth2 login for the dashboard, restricted to guild staff.
import crypto from "node:crypto";

const DISCORD_API = "https://discord.com/api";

export function registerAuthRoutes(app, { config, checkStaff }) {
  const redirectUri = `${config.web.baseUrl}/auth/callback`;

  app.get("/auth/login", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    req.session.oauthState = state;
    const url = new URL(`${DISCORD_API}/oauth2/authorize`);
    url.searchParams.set("client_id", config.discord.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "none");
    res.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    const { code, state } = req.query;
    const expected = req.session.oauthState;
    req.session.oauthState = null;

    if (!code || !state || !expected || state !== expected) {
      return res.status(400).send(deniedPage("That sign-in attempt didn't check out. Try again."));
    }

    try {
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
      const token = await tokenRes.json();

      const meRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!meRes.ok) throw new Error(`profile fetch failed (${meRes.status})`);
      const me = await meRes.json();

      const staff = await checkStaff(me.id);
      if (!staff) {
        return res
          .status(403)
          .send(
            deniedPage(
              "You're signed in to Discord, but you don't have a moderator role in the server, so the dashboard is off-limits."
            )
          );
      }

      req.session.user = staff;
      // welcome=1 lets the app skip the entrance screen just this once,
      // so signing in doesn't ask for a second ENTER.
      res.redirect("/?welcome=1");
    } catch (err) {
      console.error("OAuth callback failed:", err);
      res.status(500).send(deniedPage("Sign-in failed on our side. Try again in a minute."));
    }
  });

  app.post("/auth/logout", (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });
}

function deniedPage(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Warden</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101418;color:#dfe5ec;
       font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
  .card{max-width:26rem;padding:2.2rem;border:1px solid #232b33;border-radius:12px;background:#161b21;text-align:center}
  a{color:#7ab8ff;text-decoration:none}
  h1{font-size:1.1rem;margin:0 0 .6rem;letter-spacing:.02em}
</style></head>
<body><div class="card"><h1>No entry</h1><p>${message}</p><p><a href="/">Back to the dashboard</a></p></div></body></html>`;
}
