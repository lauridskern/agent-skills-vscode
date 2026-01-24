![Agent Skills](https://raw.githubusercontent.com/lauridskern/agent-skills-vscode/main/resources/header.png)

Browse, install, and manage Agent Skills for AI coding agents directly from VS Code.

## Features

### Browse Skills

Discover skills from [skills.sh](https://skills.sh), an open directory of agent skills powered by Vercel. Search and filter through hundreds of community-created skills.

### Install to Multiple Agents

Install skills to any supported coding agent with a single click:

- **Cursor**
- **Claude Code**
- **Codex**
- **Gemini CLI**
- **OpenCode**
- **Antigravity**

### Flexible Installation Options

- **Project-level** or **Global** installation scope
- **Symlink** (recommended) or **Copy** installation method
- Install to multiple agents simultaneously

### Manage Installed Skills

- View all installed skills organized by agent and scope
- Quickly remove or reinstall skills
- See when skills were last updated

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Agent Skills Manager"
4. Click Install

Or install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=agent-skills.agent-skills).

## Usage

1. Click the **sparkle icon** in the Activity Bar to open Agent Skills
2. Browse the **Browse** tab to discover skills
3. Click **Install** on any skill
4. Select your target agents, scope, and installation method
5. View and manage your skills in the **Installed** tab

## Requirements

- VS Code 1.85.0 or higher
- Node.js (for npx command)

## What are Agent Skills?

Agent Skills are reusable instruction sets that extend your AI coding agent's capabilities. They're defined in `SKILL.md` files and let agents perform specialized tasks like:

- Generating release notes from git history
- Creating PRs following your team's conventions
- Integrating with external tools (Linear, Notion, etc.)
- Following framework-specific best practices

Learn more at [skills.sh](https://skills.sh).

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

MIT
