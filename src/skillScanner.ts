import * as vscode from 'vscode';
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

async function readSkillFromFile(
    skillMdPath: string,
    fallbackName: string,
    level: SkillLevel,
    mode: CompatibilityMode
): Promise<Skill> {
    const fileUri = vscode.Uri.file(skillMdPath);
    let updatedAt: number | undefined;

    try {
        const fileStat = await vscode.workspace.fs.stat(fileUri);
        updatedAt = fileStat.mtime;
    } catch {
        updatedAt = undefined;
    }

    try {
        const content = Buffer.from(
            await vscode.workspace.fs.readFile(fileUri)
        ).toString('utf-8');
        const frontmatter = parseFrontmatter(content);

        return {
            name: frontmatter.name || fallbackName,
            description: frontmatter.description || '',
            path: skillMdPath,
            level,
            mode,
            updatedAt
        };
    } catch {
        return {
            name: fallbackName,
            description: '',
            path: skillMdPath,
            level,
            mode,
            updatedAt
        };
    }
}

async function scanDirectory(dirPath: string, level: SkillLevel, mode: CompatibilityMode): Promise<Skill[]> {
    const skills: Skill[] = [];
    const dirUri = vscode.Uri.file(dirPath);

    try {
        const stat = await vscode.workspace.fs.stat(dirUri);
        if ((stat.type & vscode.FileType.Directory) === 0) {
            return skills;
        }
    } catch {
        return skills;
    }

    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
        return skills;
    }

    for (const [name, type] of entries) {
        if ((type & vscode.FileType.Directory) !== 0) {
            const candidateNames = ['SKILL.md', 'skill.md'];
            let skillFile: string | undefined;

            for (const candidate of candidateNames) {
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dirPath, name, candidate)));
                    skillFile = candidate;
                    break;
                } catch {
                    continue;
                }
            }

            if (!skillFile) {
                continue;
            }

            const skillMdPath = path.join(dirPath, name, skillFile);
            skills.push(await readSkillFromFile(skillMdPath, name, level, mode));
            continue;
        }

        if ((type & vscode.FileType.File) === 0) {
            continue;
        }

        const lowerName = name.toLowerCase();
        if (!lowerName.endsWith('.md') || lowerName === 'readme.md') {
            continue;
        }

        const skillMdPath = path.join(dirPath, name);
        const fallbackName = path.basename(name, path.extname(name));
        skills.push(await readSkillFromFile(skillMdPath, fallbackName, level, mode));
    }

    return skills;
}

export async function scanAllSkills(): Promise<Skill[]> {
    const allSkills: Skill[] = [];
    const workspaceRoots = (vscode.workspace.workspaceFolders || []).map(
        folder => folder.uri.fsPath
    );

    for (const dir of SKILL_DIRECTORIES) {
        if (dir.level === 'project') {
            for (const root of workspaceRoots) {
                try {
                    const dirPath = getSkillDirectoryPath(dir.level, dir.mode, root);
                    const skills = await scanDirectory(dirPath, dir.level, dir.mode);
                    allSkills.push(...skills);
                } catch {
                    continue;
                }
            }
            continue;
        }

        try {
            const dirPath = getSkillDirectoryPath(dir.level, dir.mode);
            const skills = await scanDirectory(dirPath, dir.level, dir.mode);
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
    const modes: CompatibilityMode[] = ['cursor', 'claude', 'codex', 'gemini', 'opencode', 'agent'];

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
