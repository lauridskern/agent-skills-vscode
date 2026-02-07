export type SkillLevel = 'project' | 'user';

export type CompatibilityMode =
    'universal' |
    'cursor' |
    'claude' |
    'codex' |
    'gemini' |
    'opencode' |
    'agent';

export interface Skill {
    name: string;
    description: string;
    path: string;
    level: SkillLevel;
    mode: CompatibilityMode;
    updatedAt?: number;
    marketplaceId?: string;
    updateAvailable?: boolean;
}

export interface SkillDirectory {
    path: string;
    level: SkillLevel;
    mode: CompatibilityMode;
}

export const SKILL_DIRECTORIES: Omit<SkillDirectory, 'path'>[] = [
    { level: 'project', mode: 'universal' },
    { level: 'project', mode: 'cursor' },
    { level: 'project', mode: 'claude' },
    { level: 'project', mode: 'codex' },
    { level: 'project', mode: 'gemini' },
    { level: 'project', mode: 'opencode' },
    { level: 'project', mode: 'agent' },
    { level: 'user', mode: 'universal' },
    { level: 'user', mode: 'cursor' },
    { level: 'user', mode: 'claude' },
    { level: 'user', mode: 'codex' },
    { level: 'user', mode: 'gemini' },
    { level: 'user', mode: 'opencode' },
    { level: 'user', mode: 'agent' }
];

export function getSkillDirectoryPath(level: SkillLevel, mode: CompatibilityMode, workspaceRoot?: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const configHome = process.env.XDG_CONFIG_HOME || `${homeDir}/.config`;

    if (level === 'project') {
        if (!workspaceRoot) {
            throw new Error('Workspace root is required for project-level skills');
        }

        if (mode === 'universal') {
            return `${workspaceRoot}/.agents/skills`;
        }

        const modeToFolder: Record<CompatibilityMode, string> = {
            universal: '.agents',
            cursor: '.cursor',
            claude: '.claude',
            codex: '.codex',
            gemini: '.gemini',
            opencode: '.opencode',
            agent: '.agent'
        };

        return `${workspaceRoot}/${modeToFolder[mode]}/skills`;
    }

    // Global paths aligned with upstream `skills` CLI agent mappings.
    if (mode === 'universal') {
        return `${homeDir}/.agents/skills`;
    }
    if (mode === 'opencode') {
        return `${configHome}/opencode/skills`;
    }
    if (mode === 'agent') {
        return `${homeDir}/.gemini/antigravity/skills`;
    }

    const modeToFolder: Record<CompatibilityMode, string> = {
        universal: '.agents',
        cursor: '.cursor',
        claude: '.claude',
        codex: '.codex',
        gemini: '.gemini',
        opencode: '.opencode',
        agent: '.agent'
    };

    return `${homeDir}/${modeToFolder[mode]}/skills`;
}

export function getModeDisplayName(mode: CompatibilityMode): string {
    const names: Record<CompatibilityMode, string> = {
        universal: 'Universal',
        cursor: 'Cursor',
        claude: 'Claude',
        codex: 'Codex',
        gemini: 'Gemini CLI',
        opencode: 'OpenCode',
        agent: 'Antigravity'
    };
    return names[mode];
}

export function getLevelDisplayName(level: SkillLevel): string {
    return level === 'project' ? 'Project Skills' : 'User Skills (Global)';
}

export function getAgentFlag(mode: CompatibilityMode): string {
    if (mode === 'universal') {
        throw new Error('Universal mode does not map to a single CLI --agent flag');
    }

    const flags: Record<Exclude<CompatibilityMode, 'universal'>, string> = {
        cursor: 'cursor',
        claude: 'claude-code',
        codex: 'codex',
        gemini: 'gemini-cli',
        opencode: 'opencode',
        agent: 'antigravity'
    };
    return flags[mode];
}
