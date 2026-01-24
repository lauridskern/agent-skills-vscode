export type SkillLevel = 'project' | 'user';

export type CompatibilityMode = 'cursor' | 'claude' | 'codex';

export interface Skill {
    name: string;
    description: string;
    path: string;
    level: SkillLevel;
    mode: CompatibilityMode;
}

export interface SkillDirectory {
    path: string;
    level: SkillLevel;
    mode: CompatibilityMode;
}

export const SKILL_DIRECTORIES: Omit<SkillDirectory, 'path'>[] = [
    { level: 'project', mode: 'cursor' },
    { level: 'project', mode: 'claude' },
    { level: 'project', mode: 'codex' },
    { level: 'user', mode: 'cursor' },
    { level: 'user', mode: 'claude' },
    { level: 'user', mode: 'codex' }
];

export function getSkillDirectoryPath(level: SkillLevel, mode: CompatibilityMode, workspaceRoot?: string): string {
    const modeToFolder: Record<CompatibilityMode, string> = {
        cursor: '.cursor',
        claude: '.claude',
        codex: '.codex'
    };

    const folder = modeToFolder[mode];

    if (level === 'project') {
        if (!workspaceRoot) {
            throw new Error('Workspace root is required for project-level skills');
        }
        return `${workspaceRoot}/${folder}/skills`;
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    return `${homeDir}/${folder}/skills`;
}

export function getModeDisplayName(mode: CompatibilityMode): string {
    const names: Record<CompatibilityMode, string> = {
        cursor: 'Cursor',
        claude: 'Claude',
        codex: 'Codex'
    };
    return names[mode];
}

export function getLevelDisplayName(level: SkillLevel): string {
    return level === 'project' ? 'Project Skills' : 'User Skills (Global)';
}

export function getAgentFlag(mode: CompatibilityMode): string {
    const flags: Record<CompatibilityMode, string> = {
        cursor: 'cursor',
        claude: 'claude-code',
        codex: 'codex'
    };
    return flags[mode];
}
