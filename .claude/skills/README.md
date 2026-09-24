# Design and testing skills bundled with this site

| Skill | Source | License |
|---|---|---|
| `frontend-design` | anthropics/skills (skills/frontend-design) | see LICENSE.txt in the folder |
| `taste-skill`, `redesign-skill`, `minimalist-skill`, `soft-skill`, `brutalist-skill`, `output-skill`, `stitch-skill`, `image-to-code-skill`, `imagegen-frontend-*`, `brandkit`, `gpt-tasteskill`, `taste-skill-v1` | Leonxlnx/taste-skill | MIT |
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill (installed with `npx ui-ux-pro-max-cli init --ai claude`) | MIT |

MCP servers for live debugging and end-to-end checks are declared in `.mcp.json`
(Chrome DevTools MCP and Playwright MCP). The Playwright end-to-end suite lives in
`e2e/` and runs with `npm run e2e`.
