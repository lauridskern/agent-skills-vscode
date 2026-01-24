import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { Skill, SkillLevel, CompatibilityMode, getSkillDirectoryPath, SKILL_DIRECTORIES } from './types';

interface SkillFrontmatter {
    name?: string;
    description?: string;
}

function parseFrontmatter(content: string): SkillFrontmatter {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
        return {};
    }

    try {
        return parseYaml(frontmatterMatch[1]) as SkillFrontmatter;
    } catch {
        return {};
    }
}

function scanDirectory(dirPath: string, level: SkillLevel, mode: CompatibilityMode): Skill[] {
    const skills: Skill[] = [];

    if (!fs.existsSync(dirPath)) {
        return skills;
    }

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const skillMdPath = path.join(dirPath, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillMdPath)) {
                continue;
            }

            try {
                const content = fs.readFileSync(skillMdPath, 'utf-8');
                const frontmatter = parseFrontmatter(content);

                skills.push({
                    name: frontmatter.name || entry.name,
                    description: frontmatter.description || '',
                    path: skillMdPath,
                    level,
                    mode
                });
            } catch {
                skills.push({
                    name: entry.name,
                    description: '',
                    path: skillMdPath,
                    level,
                    mode
                });
            }
        }
    } catch {
        return skills;
    }

    return skills;
}

export function scanAllSkills(): Skill[] {
    const allSkills: Skill[] = [];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    for (const dir of SKILL_DIRECTORIES) {
        try {
            const dirPath = getSkillDirectoryPath(dir.level, dir.mode, workspaceRoot);
            const skills = scanDirectory(dirPath, dir.level, dir.mode);
            allSkills.push(...skills);
        } catch {
            continue;
        }
    }

    return allSkills;
}

export function groupSkillsByLevelAndMode(skills: Skill[]): Map<SkillLevel, Map<CompatibilityMode, Skill[]>> {
    const grouped = new Map<SkillLevel, Map<CompatibilityMode, Skill[]>>();

    const levels: SkillLevel[] = ['project', 'user'];
    const modes: CompatibilityMode[] = ['cursor', 'claude', 'codex'];

    for (const level of levels) {
        const modeMap = new Map<CompatibilityMode, Skill[]>();
        for (const mode of modes) {
            modeMap.set(mode, []);
        }
        grouped.set(level, modeMap);
    }

    for (const skill of skills) {
        const modeMap = grouped.get(skill.level);
        if (modeMap) {
            const skillList = modeMap.get(skill.mode);
            if (skillList) {
                skillList.push(skill);
            }
        }
    }

    return grouped;
}
