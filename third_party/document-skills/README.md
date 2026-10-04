# Document workflow attribution

The application workflows in `apps/server/skills/{document-design,pdf-docs,slides}`
adapt public procedural guidance, with new app-specific APIs and delivery gates:

- OpenAI `openai/skills`, revision `e6afb0d74cc75d220df2faf3dd6c635c2dc6a108`,
  `skills/.curated/{pdf,doc,slides}/SKILL.md`, Apache-2.0. See
  [source](https://github.com/openai/skills/tree/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated)
  and `OPENAI-APACHE-2.0.txt`.
- Anthropic `anthropics/skills`, revision `8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4`,
  `skills/frontend-design/SKILL.md`, Apache-2.0. See
  [source](https://github.com/anthropics/skills/tree/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/frontend-design)
  and `ANTHROPIC-FRONTEND-APACHE-2.0.txt`.

Adaptations replace external commands and installation instructions with the
app's registered tools, preserve authorized scope, select reasonable design
defaults, add exact-revision image observation and page coverage, and describe
only supported document syntax. These workflows do not install external
skills or claim that private vendor runtimes are present.

No source from Anthropic's proprietary `pdf`, `docx` or `pptx` directories was
copied. The community jiji262/claude-design-skill project was reviewed as a
user-supplied reference; its claimed internal-prompt provenance was not treated
as official vendor evidence or copied into the application.
