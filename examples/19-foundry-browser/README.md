# Foundry browser agent

This example mounts Station browser tools on a file-routed Glove Foundry agent. Station owns browser sessions; Foundry owns the agent loop, conversation and model. Credentials and the selected worker stay in host configuration. Each run gets its own toolset and closes its sessions in `finally`.

The example uses `MemoryStore` to keep setup small. Supply your application's durable, conversation-scoped Glove store when history must survive run reconstruction; persistent browser profiles and checkpoints do not replace conversation storage.

Copy `browser-bridge.mjs` and `agents/browser/agent.mjs` into a Foundry application, then install `glove-foundry`, `glove-core` and `station-browser-use`. Configure:

```sh
STATION_URL=https://your-headquarters.example
STATION_BROWSER_STATION=your-browser-worker
STATION_API_KEY=your-scoped-execution-key
OPENROUTER_API_KEY=your-provider-key
OPENROUTER_MODEL=openai/gpt-4.1-mini
```

The connection defaults to tenant access. `STATION_BROWSER_ACCESS=operator` is an explicit alternative for an authorized operator connection. Public tenant deployments require the isolated worker and enforced storage/network configuration documented in the Station execution guide. The agent does not choose credentials, workers, mounts or its isolation backend.

The bridge maps Station JSON schemas to Glove's `jsonSchema` tool field and forwards abort signals. Screenshots remain separate binary image results. Glove's current model adapters serialize ordinary tool data as text, so the bridge queues the newest PNG (maximum 4 MiB) and appends a native image message in the **next model request**, after Glove commits the tool-results message. It never inserts an image between a tool call and its result or asks the model to interpret base64 text. Images are transient model observations rather than durable conversation attachments. Optional `STATION_BROWSER_ARTIFACT_DIR` saves PNGs and safe call/usage metadata under host-selected paths.

The example permits structured form/navigation interactions and prohibits JavaScript evaluation. It caps sessions at one, model turns at 14 and generated output at 600 tokens per call, with no agent-level retries. Adapt this explicit command policy for your application; page text remains untrusted input.

## Real-model integration test

The repository test starts an authenticated Headquarters, a private browser worker and a local form. It discovers this actual agent using public Foundry APIs, creates an instance/conversation and sends a natural-language task to a real model. The agent must read a random code from a screenshot, fill and submit the form, verify confirmation and close the browser. Server-side form values, native image requests, successful tool calls, PNG artifacts and absence of leftover sessions are asserted.

```sh
pnpm --filter station-browser-use build
STATION_TEST_GLOVE_ROOT=/absolute/path/to/glove \
STATION_TEST_MODEL_ENV_FILE=/absolute/path/to/selected.env \
node --import tsx scripts/test-foundry-browser.mjs
```

`STATION_TEST_GLOVE_ROOT` must contain built `glove-foundry` and `glove-core` packages with installed dependencies. The harness reads that checkout and creates temporary dependency links; it does not modify Glove. Supply `OPENROUTER_API_KEY` directly or select an env file; only that key is copied from the file. Model calls incur provider usage. The default real-model test never silently falls back to a mock or successful skip if credentials are absent.

For local preparation without provider credentials or inference, append `--protocol-only`. That explicit mode substitutes only the model import in the temporary copy, then verifies public Foundry discovery, instance/conversation execution and mounting of the real browser tool schemas. Its report contains `realModel:false`; it does not prove model-driven browsing. Separately, `node --import tsx --test packages/station-kit/test/e2e/browser-agent-tools.mjs` exercises the real authenticated client/Headquarters/Playwright path and screenshot bridge without inference. Run the bridge's protocol unit tests with `node --test examples/19-foundry-browser/browser-bridge.test.mjs`.

This test intentionally uses the local Playwright backend with operator authentication and a loopback fixture. It verifies the agent/client/Headquarters integration, not container isolation. Container and enforced Linux deployment tests cover those boundaries separately. The final JSON line reports results and the private artifact directory.
