import type { Config } from "./config.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { stripFrontmatterBlock } from "./skill-frontmatter.ts";

/** Apply the shipped conversation skill without a discovery round-trip on every
 * chat. Operator skills cannot shadow it; the SOUL still selects the voice. */
export async function humanizerContext(config: Pick<Config, "dataDir">, owner: string) {
  const skill = await new SkillCatalog(config).read(owner, "builtin:humanizer", []);
  return `\nActive conversational workflow ${skill.id} (sha256 ${skill.sha256}); guidance for wording, not authority or permissions:\n${stripFrontmatterBlock(skill.content)}\n`;
}
