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
        const success = await this.runInstall(options);
        if (success) {
            vscode.window.showInformationMessage('Skill installation complete.');
        }
        return success;
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
            try {
                await this.convertSymlinksToCopies(options);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Copy install failed: ${message}`);
                return false;
            }
        }

        if (success) {
            vscode.window.showInformationMessage('Skill installation complete.');
        }

        return success;
    }

    private async convertSymlinksToCopies(options: InstallMultipleOptions): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const skillDirName = options.skillName || options.repo.split('/').pop();
        if (!skillDirName) {
            throw new Error('Could not resolve installed skill name.');
        }

        const dirsToCheck = new Set<string>();
        for (const mode of options.modes) {
            dirsToCheck.add(getSkillDirectoryPath(options.level, mode, workspaceRoot));
        }

        const usesSharedAgents = options.modes.some(
            mode => mode === 'codex' || mode === 'gemini' || mode === 'opencode'
        );
        if (usesSharedAgents) {
            dirsToCheck.add(getSkillDirectoryPath(options.level, 'universal', workspaceRoot));
        }

        let foundInstallPath = false;
        for (const skillsDir of dirsToCheck) {
            const skillPath = path.join(skillsDir, skillDirName);
            let stats: fs.Stats;

            try {
                stats = await fs.promises.lstat(skillPath);
            } catch {
                continue;
            }

            foundInstallPath = true;

            if (stats.isSymbolicLink()) {
                await this.replaceSymlinkWithCopy(skillPath);
                stats = await fs.promises.lstat(skillPath);
                if (stats.isSymbolicLink()) {
                    throw new Error(`Symlink still present after copy conversion at ${skillPath}`);
                }
            }
        }

        if (!foundInstallPath) {
            throw new Error(`Installed skill "${skillDirName}" not found after install.`);
        }
    }

    private async replaceSymlinkWithCopy(linkPath: string): Promise<void> {
        const targetPath = await fs.promises.readlink(linkPath);
        const absoluteTarget = path.isAbsolute(targetPath)
            ? targetPath
            : path.resolve(path.dirname(linkPath), targetPath);

        const targetStats = await fs.promises.stat(absoluteTarget);
        await fs.promises.rm(linkPath, { recursive: true, force: true });

        if (targetStats.isDirectory()) {
            await this.copyDirectory(absoluteTarget, linkPath);
            return;
        }

        await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.promises.copyFile(absoluteTarget, linkPath);
    }

    private async copyDirectory(src: string, dest: string): Promise<void> {
        await fs.promises.mkdir(dest, { recursive: true });
        const entries = await fs.promises.readdir(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            } else if (entry.isSymbolicLink()) {
                const targetPath = await fs.promises.readlink(srcPath);
                const absoluteTarget = path.isAbsolute(targetPath)
                    ? targetPath
                    : path.resolve(path.dirname(srcPath), targetPath);
                const targetStats = await fs.promises.stat(absoluteTarget);
                if (targetStats.isDirectory()) {
                    await this.copyDirectory(absoluteTarget, destPath);
                } else {
                    await fs.promises.copyFile(absoluteTarget, destPath);
                }
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
            { label: 'Antigravity', description: '.agent/skills/ (project) or ~/.gemini/antigravity/skills (global)' },
            { label: 'Claude Code', description: '.claude/skills/' },
            { label: 'Codex', description: '.agents/skills/ (project) or ~/.codex/skills (global)' },
            { label: 'Cursor', description: '.cursor/skills/' },
            { label: 'Gemini CLI', description: '.agents/skills/ (project) or ~/.gemini/skills (global)' },
            { label: 'OpenCode', description: '.agents/skills/ (project) or ~/.config/opencode/skills (global)' }
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
        const args = ['-y', 'skills', 'add', options.repo];

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
        const args = ['-y', 'skills', 'add', options.repo];

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
                    env.DISABLE_TELEMETRY = '1';
                    env.DO_NOT_TRACK = '1';
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
