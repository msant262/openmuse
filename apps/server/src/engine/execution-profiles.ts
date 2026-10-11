import { z } from "zod";
import { workspacePath } from "../computer.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const selection = z.array(z.string().trim().min(1));
export const executionProfileSettings = z
  .object({
    toolsets: selection.optional(),
    platformToolsets: z.record(z.string().min(1), selection).optional(),
    disabledToolsets: selection.optional(),
    board: slug.optional(),
    model: z
      .string()
      .trim()
      .regex(/^[^/:\s]+[/:].+$/)
      .optional(),
    skills: selection.optional(),
    maxRuntimeSeconds: z.number().int().positive().optional(),
    projects: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            slug,
            primaryPath: z.string().transform(workspacePath),
          })
          .strict(),
      )
      .optional(),
    defaultProject: z.string().trim().min(1).max(200).optional(),
    workdir: z.string().transform(workspacePath).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const selectors = new Set<string>();
    for (const project of profile.projects ?? []) {
      for (const key of new Set([project.id, project.slug].map(projectSelector))) {
        if (selectors.has(key))
          ctx.addIssue({
            code: "custom",
            message: "Project identities must be unique",
            path: ["projects"],
          });
        selectors.add(key);
      }
    }
    if (profile.defaultProject && !selectors.has(projectSelector(profile.defaultProject)))
      ctx.addIssue({
        code: "custom",
        message: "Default project must be registered in this profile",
        path: ["defaultProject"],
      });
  });
export const executionProfileChange = z
  .object({
    expectedRevision: z.number().int().min(0),
    requestId: z.string().trim().min(1),
    profile: executionProfileSettings,
  })
  .strict();
export type ExecutionProfile = z.infer<typeof executionProfileSettings> & {
  id: string;
  revision: number;
};
type Profile = ExecutionProfile;
const projectSelector = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

/** These paths come only from authenticated owner settings, never recalled text. */
export function profileWorkspaceOptions(profile: ExecutionProfile) {
  return {
    defaultProject: profile.defaultProject,
    defaultWorkdir: profile.workdir,
    resolveProject: (name: string) =>
      profile.projects?.find((project) =>
        [project.id, project.slug].some((key) => projectSelector(key) === projectSelector(name)),
      ) ?? null,
  };
}

/** Execution settings are an authenticated configuration, separate from SOUL,
 * recalled preferences and model-authored task input. */
export class ExecutionProfiles {
  constructor(private readonly db: Store) {}
  async get(owner: string, name = "default"): Promise<Profile> {
    slug.parse(name);
    const saved = await this.db.get<Profile>(owner, "execution-profiles", name);
    if (saved) return saved;
    if (name !== "default") throw new AppError("Execution profile is not configured", 404);
    return { id: name, revision: 0 };
  }
  async exists(owner: string, name: string) {
    return name === "default" || Boolean(await this.db.get(owner, "execution-profiles", name));
  }
  async set(owner: string, name: string, raw: unknown) {
    slug.parse(name);
    const input = executionProfileChange.parse(raw);
    await this.db.insertIfAbsent(owner, "execution-profiles", { id: name, revision: 0 });
    const result = await this.db.durableMutation<Profile>(
      owner,
      `execution-profile:${name}:${input.requestId}`,
      bindingHash({ name, input }),
      [
        {
          kind: "execution-profiles",
          id: name,
          mode: "replace",
          expected: { revision: input.expectedRevision },
          value: { id: name, revision: input.expectedRevision + 1, ...input.profile },
        },
      ],
    );
    if (result.status === "binding_conflict")
      throw new AppError("This request belongs to another profile change", 409);
    if (!["applied", "duplicate"].includes(result.status))
      throw new AppError("Execution settings changed; refresh and retry", 409);
    return result.values[0];
  }
  kanbanEnabled(profile: Profile, platform: string, worker = false) {
    if (profile.disabledToolsets?.includes("kanban")) return false;
    if (worker) return true;
    const selected = profile.platformToolsets?.[platform] ?? profile.toolsets;
    return Boolean(selected?.includes("kanban"));
  }
}
