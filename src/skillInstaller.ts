import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { SkillLevel, CompatibilityMode, getModeDisplayName, getAgentFlag } from './types';

export interface InstallOptions {
    repo: string;
    skillName?: string;
    level: SkillLevel;
    mode: CompatibilityMode;
}

export class SkillInstaller {
    async installSkill(repo: string, skillName?: string): Promise<boolean> {
        const level = await this.promptForLevel();
        if (!level) {
            return false;
        }

        const mode = await this.promptForMode();
        if (!mode) {
            return false;
        }

        return this.runInstall({ repo, skillName, level, mode });
    }

    async installWithOptions(options: InstallOptions): Promise<boolean> {
        return this.runInstall(options);
    }

    private async promptForLevel(): Promise<SkillLevel | undefined> {
        const items: vscode.QuickPickItem[] = [
            { label: 'Project', description: 'Install to current workspace', detail: 'Skills will be available only in this project' },
            { label: 'User (Global)', description: 'Install to user directory', detail: 'Skills will be available in all projects' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Select Installation Level',
            placeHolder: 'Where should the skill be installed?'
        });

        if (!selected) {
            return undefined;
        }

        return selected.label === 'Project' ? 'project' : 'user';
    }

    private async promptForMode(): Promise<CompatibilityMode | undefined> {
        const items: vscode.QuickPickItem[] = [
            { label: 'Cursor', description: '.cursor/skills/', detail: 'Native Cursor agent skills directory' },
            { label: 'Claude', description: '.claude/skills/', detail: 'Claude Code compatibility mode' },
            { label: 'Codex', description: '.codex/skills/', detail: 'OpenAI Codex compatibility mode' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Select Compatibility Mode',
            placeHolder: 'Which agent format should be used?'
        });

        if (!selected) {
            return undefined;
        }

        const modeMap: Record<string, CompatibilityMode> = {
            'Cursor': 'cursor',
            'Claude': 'claude',
            'Codex': 'codex'
        };

        return modeMap[selected.label];
    }

    private async runInstall(options: InstallOptions): Promise<boolean> {
        const args = ['add-skill', options.repo];

        if (options.skillName) {
            args.push('--skill', options.skillName);
        }

        if (options.level === 'user') {
            args.push('-g');
        }

        args.push('-a', getAgentFlag(options.mode));
        args.push('-y');

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        return new Promise((resolve) => {
            const terminal = vscode.window.createTerminal({
                name: 'Agent Skills',
                cwd: workspaceRoot
            });

            terminal.show();
            terminal.sendText(`npx ${args.join(' ')}`);

            vscode.window.showInformationMessage(
                `Installing skill from ${options.repo} to ${getModeDisplayName(options.mode)} (${options.level})...`
            );

            setTimeout(() => {
                resolve(true);
            }, 2000);
        });
    }
}
