import * as vscode from "vscode";
import * as https from "https";
import * as zlib from "zlib";
import { SkillInstaller } from "./skillInstaller";
import { scanAllSkills } from "./skillScanner";
import { Skill, SkillLevel, CompatibilityMode } from "./types";

interface MarketplaceSkill {
  name: string;
  repo: string;
  installs: string;
  url: string;
}

interface CachedData<T> {
  data: T;
  timestamp: number;
}

const CACHE_KEY_MARKETPLACE = "cachedMarketplaceSkills";
const CACHE_KEY_INSTALLED = "cachedInstalledSkills";
const CACHE_TTL_MS = 5 * 60 * 1000;

export class SkillsSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentSkillsView";
  private readonly _context: vscode.ExtensionContext;
  private _view?: vscode.WebviewView;
  private _installer: SkillInstaller;
  private _installedSkills: Skill[] = [];
  private _marketplaceSkills: MarketplaceSkill[] = [];
  private _isLoadingMarketplace = false;
  private _marketplaceError: string | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    installer: SkillInstaller,
    context: vscode.ExtensionContext,
  ) {
    this._installer = installer;
    this._context = context;
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    this._loadFromCache();
    this._updateWebview();
    
    this._refreshInstalledSkills().then(() => {
      this._updateWebview();
    });
    this._fetchMarketplaceSkills();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "install":
          await this._handleInstall(message.repo, message.skill);
          break;
        case "openSkill":
          this._openSkill(message.path);
          break;
        case "deleteSkill":
          await this._deleteSkill(message.path, message.name);
          break;
        case "refresh":
          await this._refreshInstalledSkills();
          await this._fetchMarketplaceSkills(true);
          break;
        case "openExternal":
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case "openUrl":
          vscode.commands.executeCommand('simpleBrowser.show', message.url);
          break;
      }
    });
  }

  public async refresh() {
    await this._refreshInstalledSkills();
    this._updateWebview();
  }

  private _loadFromCache() {
    const cachedInstalled = this._context.globalState.get<CachedData<Skill[]>>(CACHE_KEY_INSTALLED);
    if (cachedInstalled?.data) {
      this._installedSkills = cachedInstalled.data;
    }

    const cachedMarketplace = this._context.globalState.get<CachedData<MarketplaceSkill[]>>(CACHE_KEY_MARKETPLACE);
    if (cachedMarketplace?.data) {
      this._marketplaceSkills = cachedMarketplace.data;
    }
  }

  private async _refreshInstalledSkills() {
    this._installedSkills = await scanAllSkills();
    this._context.globalState.update(CACHE_KEY_INSTALLED, {
      data: this._installedSkills,
      timestamp: Date.now()
    } as CachedData<Skill[]>);
  }

  private async _fetchMarketplaceSkills(forceRefresh = false) {
    if (this._isLoadingMarketplace) return;
    
    if (!forceRefresh) {
      const cached = this._context.globalState.get<CachedData<MarketplaceSkill[]>>(CACHE_KEY_MARKETPLACE);
      const isCacheValid = cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS;
      
      if (isCacheValid && this._marketplaceSkills.length > 0) {
        this._isLoadingMarketplace = false;
        return;
      }
    }

    this._isLoadingMarketplace = true;
    this._marketplaceError = null;
    if (this._marketplaceSkills.length === 0) {
      this._updateWebview();
    }

    try {
      const html = await this._httpGet("https://skills.sh/");
      this._marketplaceSkills = this._parseSkillsFromHtml(html);
      if (this._marketplaceSkills.length === 0) {
        this._marketplaceError = "No skills found in response. Try refreshing.";
      } else {
        this._context.globalState.update(CACHE_KEY_MARKETPLACE, {
          data: this._marketplaceSkills,
          timestamp: Date.now()
        } as CachedData<MarketplaceSkill[]>);
      }
    } catch (error: any) {
      this._marketplaceError = `Failed to load: ${error?.message || error}`;
    }

    this._isLoadingMarketplace = false;
    this._updateWebview();
  }

  private _httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            "User-Agent": "AgentSkillsExtension/1.0",
            Accept: "text/html,application/xhtml+xml",
            "Accept-Encoding": "gzip, deflate, br",
          },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            this._httpGet(res.headers.location).then(resolve).catch(reject);
            return;
          }

          if (res.statusCode && res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const encoding = String(
            res.headers["content-encoding"] || "",
          ).toLowerCase();
          let stream: NodeJS.ReadableStream = res;

          if (encoding.includes("gzip")) {
            stream = res.pipe(zlib.createGunzip());
          } else if (encoding.includes("br")) {
            stream = res.pipe(zlib.createBrotliDecompress());
          } else if (encoding.includes("deflate")) {
            stream = res.pipe(zlib.createInflate());
          }

          let data = "";
          stream.on("data", (chunk) => {
            data += chunk.toString();
          });
          stream.on("end", () => resolve(data));
          stream.on("error", reject);
        },
      );

      request.on("error", reject);
    });
  }

  private _parseSkillsFromHtml(html: string): MarketplaceSkill[] {
    const skills: MarketplaceSkill[] = [];
    const seen = new Set<string>();

    const linkPattern =
      /<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<\/h3>[\s\S]*?<p[^>]*>([^<]+)<\/p>[\s\S]*?([0-9,.]+K?)\s*<\/[^>]*>[\s\S]*?<\/a>/g;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const path = match[1];
      const name = match[2].trim();
      const repo = match[3].trim();
      const installs = match[4].trim();
      const url = path.startsWith("http") ? path : `https://skills.sh${path}`;
      const key = `${repo}/${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        skills.push({ name, repo, installs, url });
      }
    }

    if (skills.length === 0) {
      const urlPattern =
        /https:\/\/skills\.sh\/([^/\s"')]+)\/([^/\s"')]+)\/([^/\s"')]+)/g;
      while ((match = urlPattern.exec(html)) !== null) {
        const owner = decodeURIComponent(match[1]);
        const repoName = decodeURIComponent(match[2]);
        const skillName = decodeURIComponent(match[3]);

        if (owner === "agents" || owner === "docs" || owner === "trending")
          continue;

        const repo = `${owner}/${repoName}`;
        const key = `${repo}/${skillName}`;
        if (!seen.has(key)) {
          seen.add(key);
          skills.push({
            name: skillName,
            repo,
            installs: "—",
            url: `https://skills.sh/${owner}/${repoName}/${skillName}`,
          });
        }
      }
    }

    if (skills.length === 0) {
      const markdownPattern =
        /###\s+([^\n]+)\n([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\n([0-9,.]+K?)/g;
      while ((match = markdownPattern.exec(html)) !== null) {
        const name = match[1].trim();
        const repo = match[2].trim();
        const installs = match[3].trim();
        const key = `${repo}/${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          skills.push({
            name,
            repo,
            installs,
            url: `https://skills.sh/${repo}/${name}`,
          });
        }
      }
    }

    return skills;
  }

  private async _handleInstall(repo: string, skillName?: string) {
    const agentItems: vscode.QuickPickItem[] = [
      { label: "Antigravity", description: ".agent/skills/" },
      { label: "Claude Code", description: ".claude/skills/" },
      { label: "Codex", description: ".codex/skills/" },
      { label: "Cursor", description: ".cursor/skills/" },
      { label: "Gemini CLI", description: ".gemini/skills/" },
      { label: "OpenCode", description: ".opencode/skills/" },
    ];

    const modeMap: Record<string, CompatibilityMode | undefined> = {
      Cursor: "cursor",
      "Claude Code": "claude",
      Codex: "codex",
      "Gemini CLI": "gemini",
      OpenCode: "opencode",
      Antigravity: "agent",
    };

    const lastSelected = this._context.globalState.get<CompatibilityMode[]>(
      "agentSkills.lastSelectedAgents",
      [],
    );

    const agentSelection = await new Promise<vscode.QuickPickItem[] | undefined>(
      (resolve) => {
        const quickPick = vscode.window.createQuickPick();
        let accepted = false;

        quickPick.title = "Select agents to install skills to";
        quickPick.canSelectMany = true;
        quickPick.items = agentItems;
        quickPick.selectedItems = agentItems.filter((item) => {
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
      },
    );

    if (!agentSelection || agentSelection.length === 0) return;

    const modes = agentSelection
      .map((item) => modeMap[item.label])
      .filter((mode): mode is CompatibilityMode => Boolean(mode));

    if (modes.length === 0) {
      vscode.window.showWarningMessage("Selected agents are not supported yet.");
      return;
    }

    void this._context.globalState.update("agentSkills.lastSelectedAgents", modes);

    const levelItems: vscode.QuickPickItem[] = [
      { label: "Project", description: "Install to current workspace" },
      { label: "User (Global)", description: "Install to user directory" },
    ];

    const levelSelection = await vscode.window.showQuickPick(levelItems, {
      title: "Installation scope",
    });

    if (!levelSelection) return;

    const level: SkillLevel =
      levelSelection.label === "Project" ? "project" : "user";

    const methodItems: vscode.QuickPickItem[] = [
      { label: "Symlink (Recommended)", description: "Single source of truth, easy updates" },
      { label: "Copy to all agents", description: "Independent copies for each agent" },
    ];

    const methodSelection = await vscode.window.showQuickPick(methodItems, {
      title: "Installation method",
    });

    if (!methodSelection) return;

    const method = methodSelection.label.startsWith("Symlink") ? "symlink" : "copy";

    const telemetryItems: vscode.QuickPickItem[] = [
      { label: "No", description: "Do not send anonymous telemetry" },
      { label: "Yes", description: "Help rank skills on the leaderboard" },
    ];

    const telemetrySelection = await vscode.window.showQuickPick(telemetryItems, {
      title: "Enable anonymous telemetry?",
      placeHolder: "Telemetry only includes skill name and timestamp—no personal data",
    });

    if (!telemetrySelection) return;

    const enableTelemetry = telemetrySelection.label === "Yes";

    const didInstall = await this._installer.installWithOptionsMultiple({
      repo,
      skillName,
      level,
      modes,
      method: method as "symlink" | "copy",
      enableTelemetry,
    });

    if (didInstall) {
      await this._refreshInstalledSkills();
      this._updateWebview();
    }
  }

  private _openSkill(path: string) {
    vscode.workspace.openTextDocument(path).then((doc) => {
      vscode.window.showTextDocument(doc);
    });
  }

  private async _deleteSkill(path: string, name: string) {
    const confirm = await vscode.window.showWarningMessage(
      `Delete skill "${name}"?`,
      { modal: true },
      "Delete",
    );

    if (confirm === "Delete") {
      try {
        const skillDir = vscode.Uri.file(path.replace(/\/SKILL\.md$/, ""));
        await vscode.workspace.fs.delete(skillDir, { recursive: true });
        await this._refreshInstalledSkills();
        this._updateWebview();
        vscode.window.showInformationMessage(`Skill "${name}" deleted.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to delete skill: ${error}`);
      }
    }
  }

  private _updateWebview() {
    if (!this._view) return;
    this._view.webview.html = this._getHtmlContent(this._view.webview);
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    const installedJson = JSON.stringify(this._installedSkills);
    const marketplaceJson = JSON.stringify(this._marketplaceSkills);

    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css",
      ),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link href="${codiconsUri}" rel="stylesheet" />
    <title>Agent Skills</title>
    <style>
        :root {
            --container-padding: 0;
            --input-padding-vertical: 6px;
            --input-padding-horizontal: 8px;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        html, body {
            background: transparent;
        }

        body {
            padding: 0;
            color: var(--vscode-foreground);
            font-size: var(--vscode-font-size);
            font-weight: var(--vscode-font-weight);
            font-family: var(--vscode-font-family);
        }

        .content {
            background: var(--vscode-sideBar-background);
            min-height: 100vh;
            width: calc(100% - 1px);
            margin-right: 1px;
        }

        input, button {
            font-family: inherit;
            font-size: inherit;
        }

        input {
            display: block;
            width: 100%;
            padding: var(--input-padding-vertical) var(--input-padding-horizontal);
            color: var(--vscode-input-foreground);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
        }

        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        button {
            border: none;
            padding: var(--input-padding-vertical) var(--input-padding-horizontal);
            text-align: center;
            cursor: pointer;
            border-radius: 2px;
        }

        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .header {
            position: sticky;
            top: 0;
            z-index: 10;
            background: var(--vscode-sideBar-background);
        }

        .search-box {
            padding: 8px 8px 4px 8px;
        }

        .tabs {
            display: flex;
            padding: 0 8px;
            gap: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
        }

        .tab {
            flex: 1;
            padding: 8px 12px;
            background: none;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--vscode-foreground);
            opacity: 0.7;
            cursor: pointer;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .tab:hover {
            opacity: 1;
        }

        .tab.active {
            opacity: 1;
            border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder));
        }

        .panel {
            display: none;
        }

        .panel.active {
            display: block;
            overflow: auto;
            max-height: calc(100vh - 90px);
        }

        .list-header {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 700;
            color: var(--vscode-sideBarSectionHeader-foreground);
            background: var(--vscode-sideBarSectionHeader-background);
            cursor: pointer;
            user-select: none;
        }

        .list-header:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .list-header .arrow {
            font-size: 12px;
            margin-right: 4px;
            transition: transform 0.15s;
            -webkit-text-stroke: 0.5px currentColor;
        }

        .list-header.collapsed .arrow {
            transform: rotate(-90deg);
        }

        .list-header .badge {
            margin-left: auto;
            padding: 2px 6px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 10px;
            font-weight: normal;
        }

        .list-content {
            overflow: hidden;
        }

        .list-header.collapsed + .list-content {
            display: none;
        }

        .list-item {
            position: relative;
            display: flex;
            height: 50px;
            padding: 10px 10px;
            padding-right: 150px;
            cursor: pointer;
            align-items: flex-start;
        }

        .list-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .list-item:focus {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
            outline: none;
        }

        .item-content {
            flex: 1;
            min-width: 0;
            overflow: hidden;
        }

        .item-title {
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 1.3;
            cursor: pointer;
        }

        .item-title:hover {
            text-decoration: underline;
        }

        .item-subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 2px;
            line-height: 1.3;
        }

        .item-actions {
            position: absolute;
            right: 10px;
            top: 8px;
            bottom: 8px;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            justify-content: space-between;
        }

        .item-meta-top {
            font-size: 10px;
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }

        .item-meta-top .codicon {
            font-size: 12px;
        }

        .install-btn {
            height: 16px;
            padding: 0 5px;
            font-size: 11px;
            font-weight: 500;
            border-radius: 2px;
            line-height: 16px;
        }

        .remove-btn {
            height: 16px;
            padding: 0 5px;
            font-size: 11px;
            font-weight: 500;
            border-radius: 2px;
            line-height: 16px;
            background: rgba(255, 255, 255, 0.15);
            border: none;
            color: var(--vscode-foreground);
        }

        .remove-btn:hover {
            background: rgba(255, 255, 255, 0.25);
        }

        .reinstall-btn {
            height: 16px;
            padding: 0 5px;
            font-size: 11px;
            font-weight: 500;
            border-radius: 2px;
            line-height: 16px;
            background: rgba(255, 255, 255, 0.15);
            border: none;
            color: var(--vscode-foreground);
        }

        .reinstall-btn:hover {
            background: rgba(255, 255, 255, 0.25);
        }

        .item-buttons {
            display: flex;
            gap: 4px;
            padding-top: 2px;
        }

        .list-item.installed-gradient {
            background: linear-gradient(90deg, transparent 0%, rgba(135, 161, 191, 0.08) 100%);
        }

        .list-item.installed-gradient:hover {
            background: linear-gradient(90deg, var(--vscode-list-hoverBackground) 0%, rgba(135, 161, 191, 0.15) 100%);
        }

        .empty-state {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .empty-state a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }

        .empty-state a:hover {
            text-decoration: underline;
        }

        .marketplace-disclaimer {
            position: sticky;
            top: 0;
            z-index: 5;
            padding: 8px 10px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .marketplace-disclaimer a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .marketplace-disclaimer a:hover {
            text-decoration: underline;
        }

        .loading {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }

    </style>
</head>
<body>
    <div class="content">
    <div class="header">
        <div class="search-box">
            <input type="text" id="search" placeholder="Search skills...">
        </div>

        <div class="tabs">
            <button class="tab active" data-panel="installed">Installed</button>
            <button class="tab" data-panel="marketplace">Browse</button>
        </div>
    </div>

        <div class="panel active" id="installed-panel">
            <div id="installed-list"></div>
        </div>

        <div class="panel" id="marketplace-panel">
            <div id="marketplace-list"></div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        const installed = ${installedJson};
        const marketplace = ${marketplaceJson};
        const isLoading = ${this._isLoadingMarketplace};
        const loadError = ${JSON.stringify(this._marketplaceError)};
        
        let activePanel = 'installed';
        let searchQuery = '';

        const installedList = document.getElementById('installed-list');
        const marketplaceList = document.getElementById('marketplace-list');

        function esc(str) {
            const d = document.createElement('div');
            d.textContent = str || '';
            return d.innerHTML;
        }

        function groupBy(arr, keyFn) {
            return arr.reduce((acc, item) => {
                const key = keyFn(item);
                (acc[key] = acc[key] || []).push(item);
                return acc;
            }, {});
        }

        function renderInstalled() {
            let items = installed;
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                items = items.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
            }

            if (items.length === 0) {
                installedList.innerHTML = '<div class="empty-state">' + 
                    (searchQuery ? 'No matching skills found.' : 'No skills installed.<br><br>Switch to Browse to discover and install skills.') + 
                '</div>';
                return;
            }

            const grouped = groupBy(items, s => s.level + '|' + s.mode);
            const order = [
                'project|cursor',
                'project|claude',
                'project|codex',
                'project|gemini',
                'project|opencode',
                'project|agent',
                'user|cursor',
                'user|claude',
                'user|codex',
                'user|gemini',
                'user|opencode',
                'user|agent'
            ];
            const labels = {
                'project|cursor': 'Project / Cursor',
                'project|claude': 'Project / Claude', 
                'project|codex': 'Project / Codex',
                'project|gemini': 'Project / Gemini CLI',
                'project|opencode': 'Project / OpenCode',
                'project|agent': 'Project / Antigravity',
                'user|cursor': 'User / Cursor',
                'user|claude': 'User / Claude',
                'user|codex': 'User / Codex',
                'user|gemini': 'User / Gemini CLI',
                'user|opencode': 'User / OpenCode',
                'user|agent': 'User / Antigravity'
            };

            let html = '';
            order.forEach(key => {
                const skills = grouped[key];
                if (!skills || skills.length === 0) return;

                html += '<div class="list-header" data-group="' + key + '">' +
                    '<span class="arrow codicon codicon-chevron-down"></span>' +
                    '<span>' + labels[key] + '</span>' +
                    '<span class="badge">' + skills.length + '</span>' +
                '</div>';
                html += '<div class="list-content">';
                skills.forEach(s => {
                    const updatedDate = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('de-DE') : '';
                    const marketplaceMatch = marketplace.find(m => m.name === s.name);
                    html += '<div class="list-item" tabindex="0" data-path="' + esc(s.path) + '">' +
                        '<div class="item-content">' +
                            '<div class="item-title title-link" data-path="' + esc(s.path) + '">' + esc(s.name) + '</div>' +
                            '<div class="item-subtitle">' + esc(s.description || 'No description') + '</div>' +
                        '</div>' +
                        '<div class="item-actions">' +
                            (updatedDate ? '<span class="item-meta-top"><span class="codicon codicon-history"></span>' + esc(updatedDate) + '</span>' : '<span></span>') +
                            '<div class="item-buttons">' +
                                (marketplaceMatch ? '<button class="reinstall-btn install-btn" data-repo="' + esc(marketplaceMatch.repo) + '" data-skill="' + esc(s.name) + '">Reinstall</button>' : '') +
                                '<button class="remove-btn delete-btn" data-path="' + esc(s.path) + '" data-name="' + esc(s.name) + '">Remove</button>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
                });
                html += '</div>';
            });

            installedList.innerHTML = html;
        }

        function renderMarketplace() {
            if (isLoading) {
                marketplaceList.innerHTML = '<div class="loading">Loading skills...</div>';
                return;
            }

            if (loadError) {
                marketplaceList.innerHTML = '<div class="empty-state">' + esc(loadError) + '<br><br><a href="#" class="retry-link">Try again</a></div>';
                const retryLink = marketplaceList.querySelector('.retry-link');
                if (retryLink) {
                    retryLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        vscode.postMessage({command: 'refresh'});
                    });
                }
                return;
            }

            let items = marketplace;
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                items = items.filter(s => s.name.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q));
            }

            if (items.length === 0) {
                marketplaceList.innerHTML = '<div class="empty-state">' + 
                    (searchQuery ? 'No matching skills found.' : 'No skills available.') + 
                '</div>';
                return;
            }

            const installedNames = new Set(installed.map(s => s.name));

            let html = '<div class="marketplace-disclaimer">Data provided by <a href="#" class="disclaimer-link" data-url="https://skills.sh">skills.sh</a>, an open directory by Vercel</div>';
            items.forEach(s => {
                const isInstalled = installedNames.has(s.name);
                const rowClass = isInstalled ? 'list-item installed-gradient' : 'list-item';
                const btnClass = isInstalled ? 'reinstall-btn install-btn' : 'primary install-btn';
                const btnLabel = isInstalled ? 'Reinstall' : 'Install';
                const skillUrl = 'https://skills.sh/' + s.repo + '/' + s.name;
                html += '<div class="' + rowClass + '" tabindex="0">' +
                    '<div class="item-content">' +
                        '<div class="item-title title-link" data-url="' + esc(skillUrl) + '">' + esc(s.name) + '</div>' +
                        '<div class="item-subtitle">' + esc(s.repo) + '</div>' +
                    '</div>' +
                    '<div class="item-actions">' +
                        '<span class="item-meta-top">' +
                            '<span class="codicon codicon-cloud-download"></span>' +
                            '<span>' + esc(s.installs) + '</span>' +
                        '</span>' +
                        '<button class="' + btnClass + '" data-repo="' + esc(s.repo) + '" data-skill="' + esc(s.name) + '">' + btnLabel + '</button>' +
                    '</div>' +
                '</div>';
            });

            marketplaceList.innerHTML = html;
        }

        function render() {
            if (activePanel === 'installed') renderInstalled();
            else renderMarketplace();
        }

        document.getElementById('search').addEventListener('input', e => {
            searchQuery = e.target.value;
            render();
        });

        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                activePanel = tab.dataset.panel;
                document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
                document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === activePanel + '-panel'));
                render();
            });
        });

        document.addEventListener('click', e => {
            if (e.target.closest('.list-header')) {
                e.target.closest('.list-header').classList.toggle('collapsed');
                return;
            }

            const titleLink = e.target.closest('.title-link');
            if (titleLink) {
                if (titleLink.dataset.path) {
                    vscode.postMessage({ command: 'openSkill', path: titleLink.dataset.path });
                } else if (titleLink.dataset.url) {
                    vscode.postMessage({ command: 'openUrl', url: titleLink.dataset.url });
                }
                return;
            }

            const disclaimerLink = e.target.closest('.disclaimer-link');
            if (disclaimerLink) {
                e.preventDefault();
                vscode.postMessage({ command: 'openUrl', url: disclaimerLink.dataset.url });
                return;
            }
            
            const installBtn = e.target.closest('.install-btn');
            if (installBtn) {
                vscode.postMessage({ command: 'install', repo: installBtn.dataset.repo, skill: installBtn.dataset.skill });
                return;
            }

            const deleteBtn = e.target.closest('.delete-btn');
            if (deleteBtn) {
                vscode.postMessage({ command: 'deleteSkill', path: deleteBtn.dataset.path, name: deleteBtn.dataset.name });
                return;
            }
        });

        render();
    </script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
