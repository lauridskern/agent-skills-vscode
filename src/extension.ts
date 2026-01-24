import * as vscode from 'vscode';
import { SkillsSidebarProvider } from './skillsSidebarProvider';
import { SkillInstaller } from './skillInstaller';

export function activate(context: vscode.ExtensionContext) {
    console.log('[Agent Skills] Extension activating...');
    
    const skillInstaller = new SkillInstaller();
    const sidebarProvider = new SkillsSidebarProvider(context.extensionUri, skillInstaller);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SkillsSidebarProvider.viewType,
            sidebarProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );
    
    console.log('[Agent Skills] Extension activated successfully');

    context.subscriptions.push(
        vscode.commands.registerCommand('agentSkills.refresh', () => {
            sidebarProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('agentSkills.installSkill', async () => {
            const repoInput = await vscode.window.showInputBox({
                prompt: 'Enter the GitHub repository (e.g., vercel-labs/agent-skills)',
                placeHolder: 'owner/repo'
            });

            if (!repoInput) {
                return;
            }

            await skillInstaller.installSkill(repoInput);
            sidebarProvider.refresh();
        })
    );
}

export function deactivate() {}
