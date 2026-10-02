import { Directory, File, Paths } from "expo-file-system";
import { sha256 } from "./message-hash";
export interface MessageStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  update(key: string, change: (previous: string | null) => string): Promise<string>;
}
type Generation = { generation: number; value: string; hash: string };
const directory = () => {
  const dir = new Directory(Paths.document, "openmuse-messages");
  dir.create({ idempotent: true, intermediates: true });
  return dir;
};
function readSlots(key: string): Generation[] {
  let found = false;
  const values = [0, 1].flatMap((slot) => {
    const file = new File(directory(), `${sha256(key)}.${slot}.json`);
    if (!file.exists) return [];
    found = true;
    // An IO error is not evidence of a torn generation: do not overwrite inaccessible data.
    const text = file.textSync();
    try {
      const value = JSON.parse(text) as Generation;
      return Number.isSafeInteger(value.generation) &&
        value.generation > 0 &&
        typeof value.value === "string" &&
        value.hash === sha256(value.value)
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
  if (found && !values.length)
    throw new Error("Saved messages are damaged. Preserve this device's data and retry recovery.");
  return values;
}
/** Alternating complete generations preserve the previous record across a torn file write.
 * Cursor and events live inside one checksummed value, so recovery cannot split them. */
export const messageStorage: MessageStorage = {
  async read(key) {
    return readSlots(key).sort((a, b) => b.generation - a.generation)[0]?.value ?? null;
  },
  async write(key, value) {
    await this.update(key, () => value);
  },
  update(key, change) {
    const pending = (writers.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        const previous =
          readSlots(key).sort((a, b) => b.generation - a.generation)[0]?.value ?? null;
        const value = change(previous);
        writeGeneration(key, value);
        return value;
      });
    writers.set(key, pending);
    void pending
      .finally(() => {
        if (writers.get(key) === pending) writers.delete(key);
      })
      .catch(() => {});
    return pending;
  },
};
// The native application owns one JS/file writer. Persistence and checksums are on disk;
// this coordinator only serializes fresh read/modify/write between mounted chat instances.
const writers = new Map<string, Promise<string>>();
function writeGeneration(key: string, value: string) {
  const generation = Math.max(0, ...readSlots(key).map((item) => item.generation)) + 1;
  const file = new File(directory(), `${sha256(key)}.${generation % 2}.json`);
  file.create({ overwrite: true });
  file.write(JSON.stringify({ generation, value, hash: sha256(value) }));
  const confirmed = JSON.parse(file.textSync()) as Generation;
  if (confirmed.generation !== generation || confirmed.hash !== sha256(confirmed.value))
    throw new Error("Could not confirm saved messages");
}
