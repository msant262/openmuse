# OpenBao on the existing VPS

The Compose service is OpenBao 2.7.1 with a single-node Raft store on the existing VPS. It has no published port, uses a private internal network shared with the API, and does not use `-dev`, in-memory storage, or the OpenMuse database volume. The service account token is a broker-only token scoped to `secret/data/openmuse/*`; neither the browser worker nor a bot receives it.

Create the local static-seal key before starting Compose. It is deliberately ignored by Git and must be backed up separately from the OpenBao Raft snapshot:

```sh
install -d -m 700 deployment-secrets
openssl rand -out deployment-secrets/openbao-unseal.key 32
chown root:0 deployment-secrets/openbao-unseal.key
chmod 440 deployment-secrets/openbao-unseal.key
```

The OpenBao container runs as its upstream `openbao` user and joins container group 0 only to read this root-owned, read-only file. Keep the host file readable by root and that group only. The static key is stored on the same VPS, so it supports restart recovery but does not protect against VPS root compromise.

Start the service and initialize it once using the official `bao operator init` procedure for the pinned OpenBao version. Keep the recovery material and initial root token outside the OpenMuse workspace and outside the application containers. Use the root token only for setup, then:

1. Enable KV v2 at `secret` if it is not already mounted.
2. Require CAS writes on the mount: `bao write secret/config cas_required=true`.
3. Install `credentials-policy.hcl` as the `openmuse-credentials` policy.
4. Create a periodic orphan service token with only that policy: `bao token create -orphan -no-default-policy -period=72h -policy=openmuse-credentials`. Write its returned token privately to `.env` as `CREDENTIALS_OPENBAO_TOKEN`; keep all token output out of shared terminal logs. Never put the root token there.
5. Add only reviewed, exact-origin login adapters to `CREDENTIAL_ADAPTERS_JSON`. Each adapter fixes its HTTPS origin, form selectors, allowed redirects, and success/challenge signals; the model can choose an adapter ID but cannot define form fields or a destination.

Then start the stack. OpenBao is reachable only by the API over `vault-control`; no port is bound to the host. A sealed or unavailable vault prevents credential storage while independent chat and task routes remain available. The static key and Raft volume need separately protected backups.

The hybrid backup uses `backup-policy.hcl` for a separate root-operator token that
can only read `sys/storage/raft/snapshot`. It is supplied by root-private file and
stdin to the fixed snapshot command, never the agent/browser or command argv.
The archive contains `vault.snap` and excludes the static seal key. Keep the seal
key, recovery material and age identity offline separately. Follow the
[coordinated backup and isolated restore procedure](../HYBRID.md#daily-encrypted-two-host-backup).

The actual OpenBao 2.7.1 local proof in `scripts/verify_openbao.py` initializes
single-node Raft with a static key, restarts and confirms auto-unseal, restores a
snapshot and confirms its saved fixture value, then tests an incorrect seal key.
It uses loopback/temp state, no dev mode or production token. That proof passed;
production container restart/sealed behavior, resource measurement and live
authentication remain separate physical operator acceptance.

## Container bootstrap and independent renewal

The official 2.7.1 image already adds its configuration directory. Compose uses
`command: ["server"]` so the listener is loaded once. Prepare the new named Raft
volume before first start: the verified image user is UID **100**, GID **1000**;
`/openbao/data` must belong to that user with mode 0700. Use a temporary, networkless
root initializer for that volume only. Do not run the vault service as root.

Compose validates all interpolated variables even for `up --no-deps openbao`.
Use a non-secret bootstrap sentinel for the broker token only while initializing
the vault; replace it with the real scoped token before starting the API.
`deployment-secrets` and its API-readable files use UID 1000, directory 0700 and
file 0600. The separately mounted seal key remains root:0 mode 0440.

Create the backup token with the same orphan/period options and only
`-policy=openmuse-backup`; write it to `/etc/okami-backup/bao-snapshot-token` as root
0600. Both policies permit only self lookup/renewal in addition to their existing
KV or snapshot scope. They grant no token creation privileges.

Run `sudo python3 scripts/renew_openbao_tokens.py` once and install
`infra/systemd/okami-openbao-renew.service` and `.timer` in `/etc/systemd/system`;
then `sudo systemctl daemon-reload` and
`sudo systemctl enable --now okami-openbao-renew.timer`. The calendar timer runs
hourly independently of app usage. Tokens travel to the CLI on stdin; argv,
receipts and errors never expose their values. Renewal validates scope, orphan
status, service type, unlimited uses, period and absence of an explicit max TTL.

Periodic tokens can continue while renewed before their period expires. An outage
longer than 72 hours, or explicit revocation, requires operator reauthorization;
the renewal script never mints a replacement or uses a root token. Keep the
recovery material offline and revoke the bootstrap root token after validating
both orphan credentials. [OpenBao token lifecycle](https://openbao.org/docs/concepts/tokens/),
[self renewal](https://openbao.org/docs/commands/token/renew/).

OpenBao 2.7.1 rejects `disable_mlock=false`; the configuration omits it and the
container needs no IPC_LOCK capability. Its memory+swap cap equals its memory cap,
so Docker gives this service no swap allowance even when the host has swap.
