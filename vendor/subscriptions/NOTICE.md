Study Mate subscription adapters

OpenAI: native Sign in with ChatGPT (SIWC) dynamic client registration,
OAuth PKCE/OIDC and public Responses API. Study Mate identifies itself by its
own application name and stores its own issued client ID and encrypted tokens.
No Codex executable, Codex OAuth login, copied Codex credentials or backend-api
route is used in this release.
Documentation: https://developers.openai.com/siwc/token-sharing-open-source

Antigravity: experimental compatibility adapter ported with the user's explicit
authorization from their Harness-Mate project:
D:/agent移动端/src/dev/wind/agent/modelprovider/SubscriptionOAuth.kt
SubscriptionClient.kt, ProviderHttp.kt, ModelDiscovery.kt, ReasoningWire.kt

This adapter uses the same public desktop-client identifiers, Google OAuth
scopes, compatibility User-Agent and Cloud Code Assist request format as that
implementation. The existing project describes its upstream compatibility
fingerprint as following OpenCodex 2.69.0 / Antigravity IDE 2.5.5.
It does not read Harness-Mate, Google, Gemini CLI or Antigravity account files.
It is NOT an official Google third-party subscription integration. Google's
Antigravity terms restrict third-party OAuth use and provide for suspension or
termination of related accounts. A subscription does not guarantee access.
https://www.antigravity.google/terms
