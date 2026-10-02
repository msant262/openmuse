import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";

const missing = (error: unknown) =>
  error && typeof error === "object" && "code" in error && error.code === "ENOENT";
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

async function protectedDirectory(file: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const stat = await lstat(dirname(file));
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Credential directory must be a real directory.");
  await chmod(dirname(file), 0o700);
}

export async function readProtected(file: string): Promise<unknown | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 1024 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error(
        "Credential file must be owner-only (chmod 600), a regular file, and at most 1 MB.",
      );
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (missing(error)) return undefined;
    throw new Error("Could not read protected credentials. Check file permissions and format.");
  } finally {
    await handle?.close();
  }
}

export async function writeProtected(file: string, data: unknown) {
  await protectedDirectory(file);
  const stat = await lstat(file).catch((error) => {
    if (!missing(error)) throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw new Error("Credential target must be a regular file.");
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Shared volume lock also serializes API/standalone task-worker token rotation. */
export async function withCredentialLock<T>(
  file: string,
  operation: (assertOwnership: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await protectedDirectory(file);
  const deadline = Date.now() + 45000;
  let release: (() => Promise<void>) | undefined;
  let compromised = false;
  // A rotating authority may already have consumed the old refresh token.
  // Consumer cancellation must never discard its validated replacement.
  const assertOwnership = () => {
    if (compromised)
      throw new Error(
        "Credential lock was compromised. Check the shared credential volume before retrying.",
      );
  };
  for (;;) {
    signal?.throwIfAborted();
    assertOwnership();
    try {
      release = await lock(file, {
        realpath: false,
        stale: 120000,
        update: 10000,
        retries: 0,
        onCompromised: () => {
          compromised = true;
        },
      });
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ELOCKED"))
        throw new Error("Could not lock credentials. Check the shared credential volume.");
      if (Date.now() > deadline) throw new Error("Credential refresh is busy. Try again shortly.");
      await sleep(50, signal);
    }
  }
  try {
    signal?.throwIfAborted();
    assertOwnership();
    const value = await operation(assertOwnership);
    assertOwnership();
    signal?.throwIfAborted();
    return value;
  } finally {
    await release();
  }
}

export async function hostId(authDir: string) {
  const file = `${authDir}/host.json`;
  return withCredentialLock(file, async () => {
    const saved = await readProtected(file);
    if (
      saved &&
      typeof saved === "object" &&
      "id" in saved &&
      typeof saved.id === "string" &&
      /^urn:uuid:[0-9a-f-]{36}$/.test(saved.id)
    )
      return saved.id;
    if (saved !== undefined) throw new Error("Invalid saved agent host identity.");
    const id = `urn:uuid:${randomUUID()}`;
    await writeProtected(file, { id });
    return id;
  });
}
