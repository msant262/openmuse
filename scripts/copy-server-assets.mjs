import { cp, mkdir } from "node:fs/promises";

for (const path of ["packages/integrations/assets", "apps/server/skills"]) {
  const target = new URL(`../dist/${path}/`, import.meta.url);
  await mkdir(target, { recursive: true });
  await cp(new URL(`../${path}/`, import.meta.url), target, { recursive: true });
}
