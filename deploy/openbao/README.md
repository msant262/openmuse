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
4. Create a non-root service token with only that policy and put it in the ignored deployment `.env` as `CREDENTIALS_OPENBAO_TOKEN`. Never put the root token there.
5. Add only reviewed, exact-origin login adapters to `CREDENTIAL_ADAPTERS_JSON`. Each adapter fixes its HTTPS origin, form selectors, allowed redirects, and success/challenge signals; the model can choose an adapter ID but cannot define form fields or a destination.

Then start the stack. OpenBao is reachable only by the API over `vault-control`; no port is bound to the host. A sealed or unavailable vault prevents credential storage while independent chat and task routes remain available. The static key and Raft volume need separately protected backups. Restore testing, resource measurement, and live authentication are operator acceptance steps and have not been run in this implementation.
