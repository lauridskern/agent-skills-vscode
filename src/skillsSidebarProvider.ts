import * as vscode from "vscode";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import * as zlib from "zlib";
import { SkillInstaller } from "./skillInstaller";
import { scanAllSkills } from "./skillScanner";
import { Skill, SkillLevel, CompatibilityMode } from "./types";

interface MarketplaceSkill {
  id: string;
  name: string;
  installs: number;
  topSource: string;
}

interface SkillsApiResponse {
  skills: MarketplaceSkill[];
  hasMore: boolean;
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
  private _isLoadingMore = false;
  private _marketplaceError: string | null = null;
  private _hasMore = false;
  private _currentOffset = 0;
  private _searchQuery = "";
  private _isSearching = false;
  private _activePanel: "installed" | "marketplace" = "installed";
  private _installedScrollTop = 0;
  private _marketplaceScrollTop = 0;
  private _webviewReady = false;
  private _lastBrowseSkills: MarketplaceSkill[] = [];
  private _lastBrowseHasMore = false;
  private _lastBrowseOffset = 0;
  private _searchRequestId = 0;
  private _browseRequestId = 0;
  private static readonly PAGE_SIZE = 50;

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
    this._webviewReady = false;
    webviewView.webview.html = this._getHtmlContent(webviewView.webview);
    
    this._refreshInstalledSkills().then(() => {
      this._updateWebview();
    });
    this._fetchMarketplaceSkills();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._refreshInstalledSkills().then(() => {
          this._updateWebview();
        });
      }
    });

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
          this._searchQuery = "";
          this._isSearching = false;
          this._searchRequestId += 1;
          await this._fetchMarketplaceSkills(true);
          break;
        case "openExternal":
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case "openUrl":
          vscode.commands.executeCommand('simpleBrowser.show', message.url);
          break;
        case "search":
          await this._handleSearch(message.query);
          break;
        case "loadMore":
          await this._loadMoreSkills();
          break;
        case "setActivePanel":
          this._activePanel = message.panel;
          break;
        case "webviewReady":
          this._webviewReady = true;
          this._updateWebview();
          break;
        case "panelScroll":
          if (message.panel === "installed") {
            this._installedScrollTop = Number(message.scrollTop) || 0;
          } else if (message.panel === "marketplace") {
            this._marketplaceScrollTop = Number(message.scrollTop) || 0;
          }
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

    const cachedMarketplace = this._context.globalState.get<CachedData<{ skills: MarketplaceSkill[]; hasMore: boolean }>>(CACHE_KEY_MARKETPLACE);
    if (cachedMarketplace?.data?.skills) {
      this._marketplaceSkills = cachedMarketplace.data.skills;
      this._hasMore = cachedMarketplace.data.hasMore;
      this._currentOffset = this._marketplaceSkills.length;
      this._lastBrowseSkills = this._marketplaceSkills;
      this._lastBrowseHasMore = this._hasMore;
      this._lastBrowseOffset = this._currentOffset;
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
      const cached = this._context.globalState.get<CachedData<{ skills: MarketplaceSkill[]; hasMore: boolean }>>(CACHE_KEY_MARKETPLACE);
      const isCacheValid = cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS;
      
      if (isCacheValid && this._marketplaceSkills.length > 0) {
        this._hasMore = cached.data.hasMore;
        this._isLoadingMarketplace = false;
        return;
      }
    }

    const shouldApplyAtStart = !this._isSearching && !this._searchQuery.trim();
    if (shouldApplyAtStart) {
      this._isLoadingMarketplace = true;
      this._marketplaceError = null;
      this._currentOffset = 0;
      if (this._marketplaceSkills.length === 0) {
        this._updateWebview();
      }
    }
    const requestId = ++this._browseRequestId;

    try {
      const url = `https://skills.sh/api/skills?limit=${SkillsSidebarProvider.PAGE_SIZE}&offset=0`;
      const response = await this._httpGetJson<SkillsApiResponse>(url);
      if (requestId !== this._browseRequestId) return;
      const nextSkills = response.skills;
      const nextHasMore = response.hasMore;
      const nextOffset = response.skills.length;

      this._lastBrowseSkills = nextSkills;
      this._lastBrowseHasMore = nextHasMore;
      this._lastBrowseOffset = nextOffset;

      const shouldApplyNow = !this._isSearching && !this._searchQuery.trim();
      if (shouldApplyNow) {
        this._marketplaceSkills = nextSkills;
        this._hasMore = nextHasMore;
        this._currentOffset = nextOffset;
      }
      
      if (shouldApplyNow && this._marketplaceSkills.length === 0) {
        this._marketplaceError = "No skills found in response. Try refreshing.";
      } else {
        this._context.globalState.update(CACHE_KEY_MARKETPLACE, {
          data: { skills: nextSkills, hasMore: nextHasMore },
          timestamp: Date.now()
        } as CachedData<{ skills: MarketplaceSkill[]; hasMore: boolean }>);
      }
    } catch (error: any) {
      if (requestId !== this._browseRequestId) return;
      const shouldApplyNow = !this._isSearching && !this._searchQuery.trim();
      if (shouldApplyNow) {
        this._marketplaceError = `Failed to load: ${error?.message || error}`;
      }
    }

    const shouldApplyNow = !this._isSearching && !this._searchQuery.trim();
    if (requestId === this._browseRequestId && shouldApplyNow) {
      this._isLoadingMarketplace = false;
      this._updateWebview();
    }
  }

  private async _handleSearch(query: string) {
    const trimmedQuery = query.trim();
    this._searchQuery = query;
    this._activePanel = "marketplace";
    const requestId = ++this._searchRequestId;
    
    if (!trimmedQuery) {
      this._isSearching = false;
      this._isLoadingMarketplace = false;
      this._marketplaceError = null;
      if (this._lastBrowseSkills.length > 0) {
        this._marketplaceSkills = this._lastBrowseSkills;
        this._hasMore = this._lastBrowseHasMore;
        this._currentOffset = this._lastBrowseOffset;
        this._marketplaceError = null;
        this._isLoadingMarketplace = false;
        this._updateWebview();
        void this._fetchMarketplaceSkills(true);
        return;
      }
      await this._fetchMarketplaceSkills(true);
      return;
    }

    this._isSearching = true;
    this._isLoadingMarketplace = true;
    this._marketplaceError = null;
    this._updateWebview();

    try {
      const url = `https://skills.sh/api/search?q=${encodeURIComponent(trimmedQuery)}&limit=${SkillsSidebarProvider.PAGE_SIZE}`;
      const response = await this._httpGetJson<SkillsApiResponse>(url);
      if (requestId !== this._searchRequestId) {
        return;
      }
      this._marketplaceSkills = response.skills;
      this._hasMore = response.hasMore;
      this._currentOffset = response.skills.length;
    } catch (error: any) {
      if (requestId !== this._searchRequestId) {
        return;
      }
      this._marketplaceError = `Search failed: ${error?.message || error}`;
    }

    if (requestId === this._searchRequestId) {
      this._isLoadingMarketplace = false;
      this._updateWebview();
    }
  }

  private async _loadMoreSkills() {
    if (this._isLoadingMore || !this._hasMore) return;

    this._isLoadingMore = true;
    this._activePanel = "marketplace";
    this._updateWebview();

    let shouldApply = true;
    try {
      const requestSearchId = this._searchRequestId;
      const requestQuery = this._searchQuery.trim();
      const requestIsSearching = this._isSearching;
      let url: string;
      if (requestIsSearching && requestQuery) {
        url = `https://skills.sh/api/search?q=${encodeURIComponent(requestQuery)}&limit=${SkillsSidebarProvider.PAGE_SIZE}&offset=${this._currentOffset}`;
      } else {
        url = `https://skills.sh/api/skills?limit=${SkillsSidebarProvider.PAGE_SIZE}&offset=${this._currentOffset}`;
      }
      
      const response = await this._httpGetJson<SkillsApiResponse>(url);
      if (requestIsSearching) {
        if (requestSearchId !== this._searchRequestId || !this._isSearching || this._searchQuery.trim() !== requestQuery) {
          shouldApply = false;
        }
      } else if (this._isSearching || this._searchQuery.trim() !== requestQuery) {
        shouldApply = false;
      }
      if (shouldApply) {
        this._marketplaceSkills = [...this._marketplaceSkills, ...response.skills];
        this._hasMore = response.hasMore;
        this._currentOffset += response.skills.length;
        if (!this._isSearching || !this._searchQuery.trim()) {
          this._lastBrowseSkills = this._marketplaceSkills;
          this._lastBrowseHasMore = this._hasMore;
          this._lastBrowseOffset = this._currentOffset;
        }
      }
    } catch (error: any) {
      this._marketplaceError = `Failed to load more: ${error?.message || error}`;
    }

    this._isLoadingMore = false;
    this._updateWebview();
  }

  private _httpGet(url: string, accept = "text/html,application/xhtml+xml"): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            "User-Agent": "AgentSkillsExtension/1.0",
            Accept: accept,
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
            this._httpGet(res.headers.location, accept).then(resolve).catch(reject);
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

  private async _httpGetJson<T>(url: string): Promise<T> {
    const response = await this._httpGet(url, "application/json");
    return JSON.parse(response) as T;
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

  private async _deleteSkill(skillPath: string, name: string) {
    const matching = this._installedSkills.filter((skill) => skill.name === name);
    let confirmLabel = "Delete";
    let removeAll = false;

    if (matching.length > 1) {
      const choice = await vscode.window.showWarningMessage(
        `Skill "${name}" is installed for multiple agents. Remove from all agents?`,
        { modal: true },
        "Yes",
        "No",
      );

      if (!choice) {
        return;
      }

      removeAll = choice === "Yes";
      confirmLabel = removeAll ? "Remove all" : "Remove this";
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete skill "${name}"?`,
      { modal: true },
      confirmLabel,
    );

    if (confirm !== confirmLabel) {
      return;
    }

    try {
      const pathsToDelete = removeAll
        ? matching.map((skill) => skill.path)
        : [skillPath];

      const deletedTargets = new Set<string>();
      const resolvedTargets = new Set<string>();

      for (const target of pathsToDelete) {
        const { targetPath, resolvedTarget } = await this._deleteSkillPath(target);
        deletedTargets.add(targetPath);
        if (resolvedTarget) {
          resolvedTargets.add(resolvedTarget);
        }
      }

      if (resolvedTargets.size > 0) {
        for (const resolvedTarget of resolvedTargets) {
          const normalizedResolved = path.normalize(resolvedTarget);
          const normalizedLower = normalizedResolved.toLowerCase();
          const agentsMarker = `${path.sep}.agents${path.sep}skills${path.sep}`;
          const shouldDeleteSource = normalizedLower.includes(agentsMarker);
          if (shouldDeleteSource && !deletedTargets.has(resolvedTarget)) {
            await fs.promises.rm(resolvedTarget, { recursive: true, force: true });
          }
        }
      }

      await this._refreshInstalledSkills();
      this._updateWebview();
      vscode.window.showInformationMessage(`Skill "${name}" deleted.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete skill: ${error}`);
    }
  }

  private async _deleteSkillPath(skillPath: string): Promise<{ targetPath: string; resolvedTarget?: string }> {
    const normalizedPath = path.normalize(skillPath);
    const baseName = path.basename(normalizedPath).toLowerCase();
    const isSkillMarkdown = baseName === "skill.md";
    const targetPath = isSkillMarkdown ? path.dirname(normalizedPath) : normalizedPath;
    let resolvedTarget: string | undefined;

    try {
      const stats = await fs.promises.lstat(targetPath);
      if (stats.isSymbolicLink()) {
        resolvedTarget = await fs.promises.realpath(targetPath);
      }
    } catch {
    }

    await fs.promises.rm(targetPath, { recursive: true, force: true });
    return { targetPath, resolvedTarget };
  }

  private _updateWebview() {
    if (!this._view || !this._webviewReady) return;
    this._view.webview.postMessage({
      command: "state",
      state: this._getWebviewState(),
    });
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    const initialStateJson = JSON.stringify(this._getWebviewState());

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
        
        const initialState = ${initialStateJson};
        let state = initialState || {};
        let activePanel = state.activePanel || 'installed';
        let searchTimeout = null;
        let scrollRaf = null;

        const installedList = document.getElementById('installed-list');
        const marketplaceList = document.getElementById('marketplace-list');
        const searchInput = document.getElementById('search');
        const installedPanel = document.getElementById('installed-panel');
        const marketplacePanel = document.getElementById('marketplace-panel');

        const persistedState = vscode.getState() || {};
        const scrollState = {
            installed: state.scroll?.installed ?? persistedState.scroll?.installed ?? 0,
            marketplace: state.scroll?.marketplace ?? persistedState.scroll?.marketplace ?? 0
        };
        let localSearchQuery = persistedState.search?.query ?? state.searchQuery ?? '';
        let installed = state.installedSkills || [];
        let marketplace = state.marketplaceSkills || [];
        let isLoading = Boolean(state.isLoadingMarketplace);
        let isLoadingMore = Boolean(state.isLoadingMore);
        let hasMore = Boolean(state.hasMore);
        let loadError = state.marketplaceError || null;

        searchInput.value = localSearchQuery;

        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === activePanel));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === activePanel + '-panel'));

        function esc(str) {
            const d = document.createElement('div');
            d.textContent = str != null ? String(str) : '';
            return d.innerHTML;
        }

        function formatInstalls(num) {
            if (typeof num !== 'number') return String(num);
            if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1).replace(/\\.0$/, '') + 'K';
            return String(num);
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
            if (localSearchQuery) {
                const q = localSearchQuery.toLowerCase();
                items = items.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
            }

            if (items.length === 0) {
                installedList.innerHTML = '<div class="empty-state">' + 
                    (localSearchQuery ? 'No matching skills found.' : 'No skills installed.<br><br>Switch to Browse to discover and install skills.') + 
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
                                (marketplaceMatch ? '<button class="reinstall-btn install-btn" data-repo="' + esc(marketplaceMatch.topSource) + '" data-skill="' + esc(s.name) + '">Reinstall</button>' : '') +
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
            if (isLoading && marketplace.length === 0) {
                marketplaceList.innerHTML = '<div class="loading">Loading skills...</div>';
                return;
            }

            if (loadError && marketplace.length === 0) {
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

            const items = marketplace;

            if (items.length === 0) {
                marketplaceList.innerHTML = '<div class="empty-state">' + 
                    (localSearchQuery ? 'No matching skills found.' : 'No skills available.') + 
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
                const skillUrl = 'https://skills.sh/' + esc(s.topSource) + '/' + esc(s.name);
                html += '<div class="' + rowClass + '" tabindex="0">' +
                    '<div class="item-content">' +
                        '<div class="item-title title-link" data-url="' + esc(skillUrl) + '">' + esc(s.name) + '</div>' +
                        '<div class="item-subtitle">' + esc(s.topSource) + '</div>' +
                    '</div>' +
                    '<div class="item-actions">' +
                        '<span class="item-meta-top">' +
                            '<span class="codicon codicon-cloud-download"></span>' +
                            '<span>' + formatInstalls(s.installs) + '</span>' +
                        '</span>' +
                        '<button class="' + btnClass + '" data-repo="' + esc(s.topSource) + '" data-skill="' + esc(s.name) + '">' + btnLabel + '</button>' +
                    '</div>' +
                '</div>';
            });

            if (hasMore) {
                html += '<div id="load-more-trigger" class="loading" style="padding: 12px;">' + 
                    (isLoadingMore ? 'Loading more...' : '') + 
                '</div>';
            }

            marketplaceList.innerHTML = html;
            setupInfiniteScroll();
        }

        function setupInfiniteScroll() {
            const trigger = document.getElementById('load-more-trigger');
            if (!trigger || !hasMore) return;

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && hasMore && !isLoadingMore && !isLoading) {
                        vscode.postMessage({ command: 'loadMore' });
                    }
                });
            }, { threshold: 0.1 });

            observer.observe(trigger);
        }

        function persistState(next) {
            const current = vscode.getState() || {};
            vscode.setState({ ...current, ...next });
        }

        function applyState(nextState) {
            if (!nextState) return;
            state = nextState;
            installed = state.installedSkills || [];
            marketplace = state.marketplaceSkills || [];
            isLoading = Boolean(state.isLoadingMarketplace);
            isLoadingMore = Boolean(state.isLoadingMore);
            hasMore = Boolean(state.hasMore);
            loadError = state.marketplaceError || null;
            activePanel = state.activePanel || activePanel;
            const isFocused = document.activeElement === searchInput;
            if (!isFocused) {
                localSearchQuery = state.searchQuery ?? localSearchQuery;
                searchInput.value = localSearchQuery;
                const current = vscode.getState() || {};
                persistState({ search: { ...(current.search || {}), query: localSearchQuery } });
            }
            document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === activePanel));
            document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === activePanel + '-panel'));
        }

        function render() {
            if (activePanel === 'installed') renderInstalled();
            else renderMarketplace();
            requestAnimationFrame(() => {
                if (activePanel === 'installed' && installedPanel) {
                    installedPanel.scrollTop = scrollState.installed || 0;
                } else if (activePanel === 'marketplace' && marketplacePanel) {
                    marketplacePanel.scrollTop = scrollState.marketplace || 0;
                }
            });
        }

        searchInput.addEventListener('input', e => {
            localSearchQuery = e.target.value;
            const current = vscode.getState() || {};
            persistState({ search: { ...(current.search || {}), query: localSearchQuery } });
            
            if (activePanel === 'installed') {
                render();
            } else {
                scrollState.marketplace = 0;
                if (marketplacePanel) {
                    marketplacePanel.scrollTop = 0;
                }
                if (searchTimeout) clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    vscode.postMessage({ command: 'search', query: localSearchQuery });
                }, 150);
            }
        });

        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                activePanel = tab.dataset.panel;
                document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
                document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === activePanel + '-panel'));
                vscode.postMessage({ command: 'setActivePanel', panel: activePanel });
                render();
            });
        });

        function scheduleScrollReport(panelKey, top) {
            scrollState[panelKey] = top;
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => {
                scrollRaf = null;
                persistState({ scroll: scrollState, activePanel });
                vscode.postMessage({ command: 'panelScroll', panel: panelKey, scrollTop: scrollState[panelKey] });
            });
        }

        if (installedPanel) {
            installedPanel.addEventListener('scroll', () => {
                scheduleScrollReport('installed', installedPanel.scrollTop);
            });
        }

        if (marketplacePanel) {
            marketplacePanel.addEventListener('scroll', () => {
                scheduleScrollReport('marketplace', marketplacePanel.scrollTop);
            });
        }

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

        window.addEventListener('message', event => {
            const message = event.data;
            if (message?.command === 'state') {
                applyState(message.state);
                render();
            }
        });

        vscode.postMessage({ command: 'webviewReady' });
        render();
    </script>
</body>
</html>`;
  }

  private _getWebviewState() {
    return {
      installedSkills: this._installedSkills,
      marketplaceSkills: this._marketplaceSkills,
      isLoadingMarketplace: this._isLoadingMarketplace,
      isLoadingMore: this._isLoadingMore,
      hasMore: this._hasMore,
      marketplaceError: this._marketplaceError,
      searchQuery: this._searchQuery,
      activePanel: this._activePanel,
      scroll: {
        installed: this._installedScrollTop,
        marketplace: this._marketplaceScrollTop,
      },
    };
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
