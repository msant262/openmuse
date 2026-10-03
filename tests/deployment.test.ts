import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";

interface ComposeService {
  mem_limit: string;
  memswap_limit: string;
  shm_size?: string;
  init: boolean;
  read_only: boolean;
  restart: string;
  pids_limit: number;
  healthcheck: { test: string[] };
  cap_drop: string[];
  cap_add?: string[];
  security_opt: string[];
  privileged?: boolean;
  pid?: string;
  network_mode?: string;
  env_file?: unknown;
  ports?: string[];
  environment: Record<string, string>;
  networks?: Record<string, { ipv4_address: string }> | string[];
  sysctls?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
  volumes?: (string | { target: string; read_only?: boolean })[];
}

test("VPS Compose has an exact decimal-safe budget and enforceable isolated service contracts", async () => {
  const source = await readFile("docker-compose.yml", "utf8");
  const yaml = parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(yaml.errors, []);
  const config = yaml.toJS() as {
    services: Record<string, ComposeService>;
    volumes: Record<string, unknown>;
  };
  const services = config.services;
  assert.deepEqual(Object.keys(services).sort(), [
    "browser",
    "computer",
    "computer-egress",
    "openbao",
    "server",
  ]);
  const bytes = (value: string) =>
    Number(value.slice(0, -1)) * (value.endsWith("g") ? 1024 ** 3 : 1024 ** 2);
  const total = Object.values(services).reduce((sum, service) => sum + bytes(service.mem_limit), 0);
  assert.equal(total, 6979321856);
  assert(total <= 7000000000);
  assert.equal(bytes(services.browser.mem_limit), 2147483648);
  assert.equal(bytes(String(services.browser.shm_size)), 1073741824);
  assert.equal(bytes(services.computer.mem_limit), 2944 * 1024 ** 2);
  assert.equal(bytes(services.openbao.mem_limit), 256 * 1024 ** 2);
  assert.equal(bytes(services["computer-egress"].mem_limit), 134217728);
  for (const [name, value] of Object.entries(services)) {
    assert(value.init && value.read_only && value.healthcheck.test);
    assert.equal(value.restart, "unless-stopped");
    assert.equal(value.mem_limit, value.memswap_limit);
    assert(value.pids_limit > 0);
    assert.deepEqual(value.cap_drop, ["ALL"]);
    assert(value.security_opt.includes("no-new-privileges:true"));
    assert(!value.privileged && value.pid !== "host" && value.network_mode !== "host");
    assert.equal(value.env_file, undefined);
    assert(!JSON.stringify(value.volumes ?? []).includes("docker.sock"));
    if (name !== "server") assert.equal(value.ports, undefined);
    if (!["computer-egress", "openbao"].includes(name)) assert.equal(value.cap_add, undefined);
  }
  assert.deepEqual(services.server.ports, ["127.0.0.1:8787:8787"]);
  assert.equal(services.server.environment.TASK_WORKER_ENABLED, "true");
  assert.equal(services.server.environment.DATABASE_URL, undefined);
  assert.equal(
    (services.server.networks as Record<string, { ipv4_address: string }>).control.ipv4_address,
    services["computer-egress"].environment.COMPUTER_SERVER_IP,
  );
  assert.deepEqual(services["computer-egress"].cap_add, ["NET_ADMIN"]);
  assert.equal(services["computer-egress"].sysctls?.["net.ipv6.conf.all.disable_ipv6"], "1");
  assert.equal(services.computer.network_mode, "service:computer-egress");
  assert.equal(services.computer.networks, undefined);
  assert.equal(services.computer.depends_on?.["computer-egress"].condition, "service_started");
  assert.equal(services.server.depends_on?.["computer-egress"].condition, "service_healthy");
  assert.deepEqual(Object.keys(services.computer.environment), ["COMPUTER_MAX_BACKGROUND_JOBS"]);
  assert.deepEqual(Object.keys(services.browser.environment).sort(), [
    "WORKER_DATA_DIR",
    "WORKER_HOST",
    "WORKER_TOKEN",
  ]);
  assert.deepEqual(Object.keys(services["computer-egress"].environment).sort(), [
    "COMPUTER_HOST_PUBLIC_IPS",
    "COMPUTER_SERVER_IP",
    "COMPUTER_TOKEN",
  ]);
  assert(
    services.computer.volumes?.some(
      (volume) =>
        typeof volume !== "string" && volume.target === "/etc/resolv.conf" && volume.read_only,
    ),
  );
  const env = await readFile(".env.example", "utf8");
  for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g))
    assert(env.includes(`${match[1]}=`), `Missing ${match[1]} example`);
  assert.deepEqual(services.openbao.cap_add, ["IPC_LOCK"]);
  assert.deepEqual(services.openbao.networks, ["vault-control"]);
  assert.equal(Object.keys(config.volumes).length, 5);
});

test("root browser image layout loads actual worker/shared modules with native strip-types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-image-layout-"));
  try {
    const worker = join(directory, "apps/worker");
    await mkdir(worker, { recursive: true });
    await cp("apps/worker/src", join(worker, "src"), { recursive: true });
    await cp("apps/worker/package.json", join(worker, "package.json"));
    await cp("package.json", join(directory, "package.json"));
    await mkdir(join(directory, "packages/domain"), { recursive: true });
    await cp("packages/domain/src", join(directory, "packages/domain/src"), { recursive: true });
    await symlink(resolve("apps/worker/node_modules"), join(directory, "node_modules"));
    await symlink(resolve("apps/worker/node_modules"), join(worker, "node_modules"));
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(join(worker, "src/server.ts"))});`,
      ],
      { stdio: "pipe" },
    );
    const dockerfile = await readFile("apps/worker/Dockerfile", "utf8");
    assert(
      dockerfile.includes("apps/worker/src ./src") &&
        dockerfile.includes("packages/domain/src /app/packages/domain/src") &&
        dockerfile.includes("ln -s /app/apps/worker/node_modules /app/node_modules"),
    );
    assert(dockerfile.includes("--experimental-strip-types"));
    const ignore = await readFile("apps/computer/.dockerignore", "utf8");
    for (const filename of [
      "runtime.py",
      "gateway.py",
      "media.py",
      "requirements.txt",
      "resolv.conf",
      "LICENSE",
    ])
      assert(ignore.includes(`!${filename}`));
    const rootIgnore = await readFile(".dockerignore", "utf8");
    assert(
      rootIgnore.includes("**/.env*") &&
        !rootIgnore.includes("!.openmuse") &&
        !rootIgnore.includes("!deployment-secrets"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host backup scripts reject dirty stops and stage real private archive round-trips", () => {
  execFileSync("bash", ["-n", "scripts/backup.sh", "scripts/restore.sh"], { stdio: "pipe" });
  execFileSync("python3", ["scripts/test_deployment_backup.py"], { stdio: "pipe", timeout: 30000 });
});
