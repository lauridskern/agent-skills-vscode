import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { SkillLevel, CompatibilityMode, getModeDisplayName, getAgentFlag, getSkillDirectoryPath } from './types';

export interface InstallOptions {
    repo: string;
    skillName?: string;
    level: SkillLevel;
    mode: CompatibilityMode;
}

type InstallMethod = 'symlink' | 'copy';

export interface InstallMultipleOptions {
    repo: string;
    skillName?: string;
    level: SkillLevel;
    modes: CompatibilityMode[];
    method: InstallMethod;
    enableTelemetry: boolean;
}

export class SkillInstaller {
    private readonly _context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }
    async installSkill(repo: string, skillName?: string): Promise<boolean> {
        const modes = await this.promptForModes();
        if (!modes || modes.length === 0) {
            return false;
        }

        const level = await this.promptForLevel();
        if (!level) {
            return false;
        }

        const method = await this.promptForMethod();
        if (!method) {
            return false;
        }

        const enableTelemetry = await this.promptForTelemetry();
        if (enableTelemetry === undefined) {
            return false;
        }

        return this.installWithOptionsMultiple({
            repo,
            skillName,
            level,
            modes,
            method,
            enableTelemetry
        });
    }

    async installWithOptions(options: InstallOptions): Promise<boolean> {
        return this.runInstall(options);
    }

    async installWithOptionsMultiple(options: InstallMultipleOptions): Promise<boolean> {
        if (options.modes.length === 0) {
            return false;
        }

        let success: boolean;
        if (options.modes.length === 1) {
            success = await this.runInstall({
                repo: options.repo,
                skillName: options.skillName,
                level: options.level,
                mode: options.modes[0]
            }, options.enableTelemetry);
        } else {
            success = await this.runInstallMany(options);
        }

        if (success && options.method === 'copy') {
            await this.convertSymlinksToCopies(options);
        }

        return success;
    }

    private async convertSymlinksToCopies(options: InstallMultipleOptions): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const baseDir = options.level === 'project' ? workspaceRoot : homeDir;
        
        if (!baseDir) return;

        const agentsDir = path.join(baseDir, '.agents', 'skills');
        
        for (const mode of options.modes) {
            try {
                const skillsDir = getSkillDirectoryPath(options.level, mode, workspaceRoot);
                const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
                
                for (const entry of entries) {
                    const entryPath = path.join(skillsDir, entry.name);
                    
                    try {
                        const stats = await fs.promises.lstat(entryPath);
                        if (stats.isSymbolicLink()) {
                            const targetPath = await fs.promises.readlink(entryPath);
                            const absoluteTarget = path.isAbsolute(targetPath) 
                                ? targetPath 
                                : path.resolve(path.dirname(entryPath), targetPath);
                            
                            await fs.promises.rm(entryPath, { force: true });
                            await this.copyDirectory(absoluteTarget, entryPath);
                        }
                    } catch {
                    }
                }
            } catch {
            }
        }

        try {
            const agentsBaseDir = path.join(baseDir, '.agents');
            if (fs.existsSync(agentsBaseDir)) {
                await fs.promises.rm(agentsBaseDir, { recursive: true, force: true });
            }
        } catch {
        }
    }

    private async copyDirectory(src: string, dest: string): Promise<void> {
        await fs.promises.mkdir(dest, { recursive: true });
        const entries = await fs.promises.readdir(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            } else {
                await fs.promises.copyFile(srcPath, destPath);
            }
        }
    }

    private async promptForLevel(): Promise<SkillLevel | undefined> {
        const items: vscode.QuickPickItem[] = [
            { label: 'Project', description: 'Install to current workspace' },
            { label: 'User (Global)', description: 'Install to user directory' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Installation scope'
        });

        if (!selected) {
            return undefined;
        }

        return selected.label === 'Project' ? 'project' : 'user';
    }

    private async promptForModes(): Promise<CompatibilityMode[] | undefined> {
        const items: vscode.QuickPickItem[] = [
            { label: 'Antigravity', description: '.agent/skills/' },
            { label: 'Claude Code', description: '.claude/skills/' },
            { label: 'Codex', description: '.codex/skills/' },
            { label: 'Cursor', description: '.cursor/skills/' },
            { label: 'Gemini CLI', description: '.gemini/skills/' },
            { label: 'OpenCode', description: '.opencode/skills/' }
        ];

        const modeMap: Record<string, CompatibilityMode | undefined> = {
            'Cursor': 'cursor',
            'Claude Code': 'claude',
            'Codex': 'codex',
            'Gemini CLI': 'gemini',
            'OpenCode': 'opencode',
            'Antigravity': 'agent'
        };

        const lastSelected = this._context.globalState.get<CompatibilityMode[]>(
            'agentSkills.lastSelectedAgents',
            []
        );

        const selected = await new Promise<vscode.QuickPickItem[] | undefined>((resolve) => {
            const quickPick = vscode.window.createQuickPick();
            let accepted = false;

            quickPick.title = 'Select agents to install skills to';
            quickPick.canSelectMany = true;
            quickPick.items = items;
            quickPick.selectedItems = items.filter((item) => {
                const mode = modeMap[item.label];
                return Boolean(mode && lastSelected.includes(mode));
            });

            quickPick.onDidAccept(() => {
                accepted = true;
                const selection = [...quickPick.selectedItems];
                quickPick.hide();
                resolve(selection);
            });

            quickPick.onDidHide(() => {
                if (!accepted) {
                    resolve(undefined);
                }
                quickPick.dispose();
            });

            quickPick.show();
        });

        if (!selected || selected.length === 0) {
            return undefined;
        }

        const modes = selected
            .map(item => modeMap[item.label])
            .filter((mode): mode is CompatibilityMode => Boolean(mode));

        if (modes.length === 0) {
            vscode.window.showWarningMessage('Selected agents are not supported yet.');
            return undefined;
        }

        void this._context.globalState.update('agentSkills.lastSelectedAgents', modes);
        return modes;
    }

    private async promptForMethod(): Promise<InstallMethod | undefined> {
        const items: vscode.QuickPickItem[] = [
            { label: 'Symlink (Recommended)', description: 'Single source of truth, easy updates' },
            { label: 'Copy to all agents', description: 'Independent copies for each agent' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Installation method'
        });

        if (!selected) {
            return undefined;
        }

        return selected.label.startsWith('Symlink') ? 'symlink' : 'copy';
    }

    private async promptForTelemetry(): Promise<boolean | undefined> {
        const items: vscode.QuickPickItem[] = [
            { label: 'No', description: 'Do not send anonymous telemetry' },
            { label: 'Yes', description: 'Help rank skills on the leaderboard' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Enable anonymous telemetry?',
            placeHolder: 'Telemetry only includes skill name and timestamp—no personal data'
        });

        if (!selected) {
            return undefined;
        }

        return selected.label === 'Yes';
    }

    private async runInstall(options: InstallOptions, enableTelemetry: boolean = false): Promise<boolean> {
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

        return this.runNpxCommand(
            args,
            workspaceRoot,
            `Installing skill from ${options.repo} to ${getModeDisplayName(options.mode)} (${options.level})...`,
            enableTelemetry
        );
    }

    private async runInstallMany(options: InstallMultipleOptions): Promise<boolean> {
        const args = ['add-skill', options.repo];

        if (options.skillName) {
            args.push('--skill', options.skillName);
        }

        if (options.level === 'user') {
            args.push('-g');
        }

        args.push('-a', ...options.modes.map(getAgentFlag));
        args.push('-y');

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        return this.runNpxCommand(
            args,
            workspaceRoot,
            `Installing skill from ${options.repo} to ${options.modes.map(getModeDisplayName).join(', ')} (${options.level})...`,
            options.enableTelemetry
        );
    }

    private async runNpxCommand(
        args: string[],
        cwd: string | undefined,
        message: string,
        enableTelemetry: boolean = false
    ): Promise<boolean> {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: message,
                cancellable: false
            },
            () => new Promise((resolve) => {
                const env = { ...process.env };
                if (!enableTelemetry) {
                    env.SKILLS_NO_TELEMETRY = '1';
                }

                const child = spawn('npx', args, { cwd, shell: true, env });
                let stderr = '';

                if (child.stderr) {
                    child.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                }

                child.on('error', (error) => {
                    vscode.window.showErrorMessage(`Install failed: ${error.message}`);
                    resolve(false);
                });

                child.on('close', (code) => {
                    if (code === 0) {
                        vscode.window.showInformationMessage('Skill installation complete.');
                        resolve(true);
                        return;
                    }

                    const detail = stderr.trim();
                    vscode.window.showErrorMessage(
                        detail ? `Install failed: ${detail}` : `Install failed with code ${code}`
                    );
                    resolve(false);
                });
            })
        );
    }
}
