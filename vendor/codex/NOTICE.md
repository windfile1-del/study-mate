Study Mate bundles the unmodified official OpenAI Codex Windows x64 executable,
version 0.164.0, from @openai/codex@0.164.0-win32-x64.

Upstream: https://github.com/openai/codex
License: Apache-2.0 (see codex-LICENSE alongside this notice).

The executable is used through the official app-server JSON-RPC protocol for
user-initiated ChatGPT/Codex sign-in and inference. No existing Codex account,
tokens, configuration, plugins or user installation is copied. Its CODEX_HOME
is isolated inside the application's D-drive data directory; auth storage uses
the Windows system keyring, without a plaintext fallback. Study Mate does not
provide shell, file editing, MCP or browser control tools to this client.

The upstream binary is not modified. The standalone package does not require
the user to install a separate CLI or runtime.

learning-models.json derives from the matching rust-v0.164.0 release's
codex-rs/models-manager/models.json. Study Mate modifies only tool exposure
metadata: apply_patch_tool_type=null, shell_type=disabled, tool_mode=null,
experimental_supported_tools=[], supports_search_tool=false, and automatic
skills/apps/plugin usage instructions disabled. These changes constrain the
client to learning Q&A; they do not grant access to any model or change account
entitlements. The binary loads this local catalog at startup. New Codex model
entries require an application/catalog update; unknown models are rejected to
avoid falling back to coding tools. Original catalog model names, reasoning,
context and availability metadata are retained. Source:
https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/models-manager/models.json
