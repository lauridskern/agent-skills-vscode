import * as vscode from "vscode";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import * as zlib from "zlib";
import { SkillInstaller } from "./skillInstaller";
import { scanAllSkills } from "./skillScanner";
import { Skill, SkillLevel, CompatibilityMode } from "./types";
import { MarketplaceSkill, RawAllTimeSkill, SkillsSearchResponse } from "./skillsMarketplaceTypes";
import { WebviewState } from "./skillsSidebarState";
import { buildSkillsSidebarHtml } from "./webview/skillsSidebarTemplate";

interface CachedData<T> {
  data: T;
  timestamp: number;
}

const CACHE_KEY_MARKETPLACE = "cachedMarketplaceSkills";
const CACHE_KEY_INSTALLED = "cachedInstalledSkills";
const CACHE_KEY_SKILL_SOURCES = "skillSourceMapping";
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
  private static readonly ALL_TIME_ENDPOINT = "https://skills.sh/api/skills/all-time";

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
      const skills = cachedMarketplace.data.skills;
      const hasMore = cachedMarketplace.data.hasMore;
      const page = Math.max(1, Math.ceil(skills.length / SkillsSidebarProvider.PAGE_SIZE));
      this._applyBrowseState(skills, hasMore, page);
      this._updateBrowseCache(skills, hasMore, page);
    }
  }

  private async _refreshInstalledSkills() {
    const skills = await scanAllSkills();
    // Merge saved marketplace id for skills
    const idMapping = this._context.globalState.get<Record<string, string>>(CACHE_KEY_SKILL_SOURCES, {});
    this._installedSkills = skills.map(skill => ({
      ...skill,
      marketplaceId: idMapping[skill.name]
    }));
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

    const shouldApplyAtStart = this._shouldApplyBrowseNow();
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
      const allSkills = await this._fetchAllTimeSkillsPage(1);
      if (requestId !== this._browseRequestId) return;

      const nextSkills = allSkills;
      const nextHasMore = allSkills.length >= SkillsSidebarProvider.PAGE_SIZE;
      const nextPage = 1;

      this._updateBrowseCache(nextSkills, nextHasMore, nextPage);

      const shouldApplyNow = this._shouldApplyBrowseNow();
      if (shouldApplyNow) {
        this._applyBrowseState(nextSkills, nextHasMore, nextPage);
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
      const shouldApplyNow = this._shouldApplyBrowseNow();
      if (shouldApplyNow) {
        this._marketplaceError = `Failed to load: ${error?.message || error}`;
      }
    }

    const shouldApplyNow = this._shouldApplyBrowseNow();
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
        this._applyBrowseState(this._lastBrowseSkills, this._lastBrowseHasMore, this._lastBrowseOffset);
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
      const response = await this._httpGetJson<SkillsSearchResponse>(url);
      if (requestId !== this._searchRequestId) {
        return;
      }
      this._marketplaceSkills = response.skills;
      this._hasMore = false;
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
    if (this._isSearching || this._isLoadingMore || this._isLoadingMarketplace || !this._hasMore) {
      return;
    }

    const requestId = this._browseRequestId;
    this._isLoadingMore = true;
    this._updateWebview();

    try {
      const nextPage = this._currentOffset + 1;
      const pageSkills = await this._fetchAllTimeSkillsPage(nextPage);

      if (requestId !== this._browseRequestId || this._isSearching) {
        return;
      }

      if (pageSkills.length === 0) {
        this._hasMore = false;
      } else {
        const merged = [...this._marketplaceSkills, ...pageSkills];
        const deduped = merged.filter((skill, index, arr) =>
          arr.findIndex((s) => s.id === skill.id) === index
        );
        this._marketplaceSkills = deduped;
        this._currentOffset = nextPage;
        this._hasMore = pageSkills.length >= SkillsSidebarProvider.PAGE_SIZE;
        this._updateBrowseCache(this._marketplaceSkills, this._hasMore, this._currentOffset);
        this._context.globalState.update(CACHE_KEY_MARKETPLACE, {
          data: { skills: this._marketplaceSkills, hasMore: this._hasMore },
          timestamp: Date.now()
        } as CachedData<{ skills: MarketplaceSkill[]; hasMore: boolean }>);
      }
    } catch (error: any) {
      this._marketplaceError = `Failed to load more: ${error?.message || error}`;
    } finally {
      this._isLoadingMore = false;
      this._updateWebview();
    }
  }

  private _httpGet(url: string, accept = "text/html,application/xhtml+xml", extraHeaders: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            "User-Agent": "AgentSkillsExtension/1.0",
            Accept: accept,
            "Accept-Encoding": "gzip, deflate, br",
            ...extraHeaders,
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

  private async _fetchAllTimeSkillsPage(page: number): Promise<MarketplaceSkill[]> {
    const url = `${SkillsSidebarProvider.ALL_TIME_ENDPOINT}/${page}`;
    const payload = await this._httpGetJson<RawAllTimeSkill[] | { skills: RawAllTimeSkill[] }>(url);
    const rawSkills = Array.isArray(payload) ? payload : payload.skills;
    return rawSkills.map((skill) => ({
      id: skill.id || `${skill.source}/${skill.skillId}`,
      skillId: skill.skillId,
      name: skill.name,
      installs: skill.installs,
      source: skill.source,
    }));
  }

  private async _handleInstall(repo: string, skillName?: string) {
    const agentItems: vscode.QuickPickItem[] = [
      { label: "Antigravity", description: ".agent/skills/ (project) or ~/.gemini/antigravity/skills (global)" },
      { label: "Claude Code", description: ".claude/skills/" },
      { label: "Codex", description: ".agents/skills/ (project) or ~/.codex/skills (global)" },
      { label: "Cursor", description: ".cursor/skills/" },
      { label: "Gemini CLI", description: ".agents/skills/ (project) or ~/.gemini/skills (global)" },
      { label: "OpenCode", description: ".agents/skills/ (project) or ~/.config/opencode/skills (global)" },
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
      // Save the marketplace id for this skill (format: source/skillName)
      const installedSkillName = skillName || repo.split('/').pop() || repo;
      const marketplaceId = `${repo}/${installedSkillName}`;
      await this._saveSkillMarketplaceId(installedSkillName, marketplaceId);
      await this._refreshInstalledSkills();
      this._updateWebview();
    }
  }

  private async _saveSkillMarketplaceId(skillName: string, marketplaceId: string) {
    const idMapping = this._context.globalState.get<Record<string, string>>(CACHE_KEY_SKILL_SOURCES, {});
    idMapping[skillName] = marketplaceId;
    await this._context.globalState.update(CACHE_KEY_SKILL_SOURCES, idMapping);
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
      state: this._buildWebviewState(),
    });
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    return buildSkillsSidebarHtml(webview, this._extensionUri, nonce, this._buildWebviewState());
  }

  private _buildWebviewState(): WebviewState {
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

  private _applyBrowseState(skills: MarketplaceSkill[], hasMore: boolean, offset: number) {
    this._marketplaceSkills = skills;
    this._hasMore = hasMore;
    this._currentOffset = offset;
  }

  private _updateBrowseCache(skills: MarketplaceSkill[], hasMore: boolean, offset: number) {
    this._lastBrowseSkills = skills;
    this._lastBrowseHasMore = hasMore;
    this._lastBrowseOffset = offset;
  }

  private _shouldApplyBrowseNow() {
    return !this._isSearching && !this._searchQuery.trim();
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
