# Local device, service, and studio setup

Local mode runs the device adapter on the host and sends device commands through ADB. The Node device service exposes that adapter to the studio over loopback HTTP. Cloud mode continues to use the Mobilerun API and does not need the device service for the studio.

## Local ADB mode

Install Android Platform Tools on the host. Connect the tablet using an authorized ADB transport. Install and configure the Mobilerun Portal app on the tablet so it can return accessibility state. Use the exact serial for `ADB_SERIAL`; the adapter does not choose between multiple devices.

Copy `.env.example` to `.env.local`, then set:

```dotenv
MOBILE_DEVICE_BACKEND=local
ADB_SERIAL=your-authorized-adb-serial
AGENT_DEVICE_IDENTITY=stable-identity-for-this-tablet
DECISION_BACKEND=jev
```

Set `TYPESAFE_CREDENTIAL_REFERENCE` to the approved 1Password field reference for runtime-only Jev credential injection. The wrapper checks the service-account identity and does not print the key. Local Rizzo can run directly with `pnpm service`.

Use a stable identity for the same physical tablet in the service, studio worker, CLI, and any benchmark process. The shared lock directory defaults to `~/.local/state/agent-device-android/locks`; `AGENT_DEVICE_LOCK_ROOT` can override it. Do not assign different lock identities to processes that can control the same tablet.

Start the HTTP service and the studio in separate host terminals:

```sh
node scripts/with-typesafe-key.mjs pnpm service
```

```sh
node scripts/with-typesafe-key.mjs pnpm dev
```

Open **http://127.0.0.1:3040**. The service binds to **127.0.0.1:3041** by default, and the studio proxies its local device requests through the service. Set `DEVICE_SERVICE_PORT` and `STUDIO_PORT` in `.env.local` to change these ports. Both processes load `.env.local` and then `.env`; exported environment values take precedence.

The service implements `GET /health`, `/devices`, `/apps`, `/observe`, and `/screenshot`, plus `POST /actions` and `/recover`. It also exposes in-memory run operations at `GET/POST /runs`, `GET /runs/:id`, and `POST /runs/:id/stop`. Requests must target loopback. Browser cross-site origins are rejected; extension-style requests without an `Origin` header are accepted. JSON request bodies are bounded. Non-launch actions require a fresh observation ID. An observation ID is single-use, including when a mutation has an uncertain response.

Each service device operation uses the common device lock. A task worker holds that same lock for its complete run, from before policy creation until the run ends. Do not treat a lock conflict as permission to send the operation through another interface. Read-only readiness checks can retry transient Portal errors; mutations are not retried automatically. An optional `TABLET_RECOVER_BIN` absolute path enables the recovery endpoint. Recovery runs that configured executable without a shell and under the shared lock.

The service runs in the foreground with `pnpm service`. Durable macOS launch and restart behavior belongs to the host provisioning repository. This repository does not install or register a LaunchAgent.

## Cloud Mobilerun mode

For the existing hosted-device setup, set `MOBILE_DEVICE_BACKEND=mobilerun`, `MOBILERUN_API_KEY`, and `MOBILERUN_DEVICE_ID` in `.env.local`. Keep `MOBILERUN_BASE_URL` at the production default unless the account uses another supported environment. Start the studio with `pnpm dev`; the cloud studio does not need `pnpm service`.

`MOBILERUN_API_KEY` and `TYPESAFE_API_KEY` are server-side credentials. The browser does not receive either account key. In local device mode, the worker removes Mobilerun keys from its environment. A Rizzo or TEV-1 worker does not inherit `TYPESAFE_API_KEY`. Jev requires `TYPESAFE_API_KEY`, and its model can be pinned with `TYPESAFE_MODEL`.

## Decision backends

Choose the backend in the studio task selector, use `--backend jev|rizzo|tev1` with the CLI, or set `DECISION_BACKEND` as the default for commands that read that environment setting.

- **Jev** is the studio default and uses TypeSafe's hosted endpoint. It requires the server-side `TYPESAFE_API_KEY`; `TYPESAFE_MODEL` can pin a supported Jev model.
- **Rizzo** uses the local endpoint `http://127.0.0.1:18094/v1/systemone`. It does not need a hosted API key. The provider checks ready status, the pinned `model.fingerprint` and model/runtime metadata, and that the expected model is served before it sends a decision. Variable load-time fields are not part of the pin. Local candidate selection sends at most 24 criteria per request and uses hierarchical rounds for larger sets. Every response distribution is checked against the exact criteria for that round before a winner is selected. Candidate choices removed in earlier rounds receive zero mass in the returned full-list distribution; that distribution is not calibrated across the complete original list.
- **TEV-1** is selectable by the current CLI and studio implementation. Before use, the provider checks the installed model digest against the configured pin. TEV-1 was included only in saved model-packet replay, not in the scored live-device comparison.

All provider responses must identify the requested model and must contain valid probability distributions over only the requested question criteria. A mismatched model, unrequested answer, unoffered choice, malformed distribution, failed local preflight, or truncated evidence stops the decision. The selection does not silently fall back to another backend.

Device transport and decision backend are separate choices. For example, `MOBILE_DEVICE_BACKEND=local` with `DECISION_BACKEND=jev` uses ADB for device access and TypeSafe for decisions; that configuration needs a TypeSafe key but no Mobilerun key.

## Studio controls and outcome status

In local mode, the studio displays periodically refreshed screenshots and offers Back, Home, and Recent Apps buttons. The local screenshot is a view, not a touch surface; local mode does not provide streamed touch or keyboard control. Cloud mode uses the Mobilerun device stream and its supported controls. Manual navigation obtains a new observation and sends the action with that observation ID.

The studio labels model-reported completion when the worker returns the policy's `DONE` outcome and exits cleanly. This is a model-declared completion, not an independent confirmation that every requested value or state is correct. Inspect a fresh device observation or use a task-specific verifier before reporting that the goal is verified. A failed post-action read, blocked result, timeout, or stop must not be described as verified completion.

`pnpm doctor` checks the selected device connection and UI observation. It does not verify an arbitrary task goal. The repository's dark-theme demo has its own state check; see [DEMO.md](./DEMO.md) for the exact verification and limits.

Local text replacement and clearing require exact field readback. Android 16 discards the ContentProvider insert return value, so transport success alone does not verify an effect. Other input receipts state `verified: false`; obtain a fresh observation to check the effect. Uncertain mutations are not replayed.

All active callers must use the current guard protocol. A crash during acquisition can leave a `.lock.guard`; confirm its recorded owner is dead before recovery. Ordinary dead-owner locks recover on the next guarded acquisition.
