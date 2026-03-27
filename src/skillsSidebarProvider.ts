import * as vscode from "vscode";
import * as https from "https";
import * as zlib from "zlib";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { SkillInstaller } from "./skillInstaller";
import { scanAllSkills } from "./skillScanner";
import { Skill, SkillLevel, CompatibilityMode } from "./types";
import {
  MarketplaceFeed,
  MarketplaceFeedResponse,
  MarketplaceSkill,
  RawMarketplaceSkill,
  SkillsSearchResponse,
} from "./skillsMarketplaceTypes";
import { WebviewState } from "./skillsSidebarState";
import { buildSkillsSidebarHtml } from "./webview/skillsSidebarTemplate";

interface CachedData<T> {
  data: T;
  timestamp: number;
}

interface CachedMarketplaceData {
  version: number;
  activeFeed: MarketplaceFeed;
  feeds: Partial<Record<MarketplaceFeed, CachedFeedState>>;
}

interface CachedFeedState {
  skills: MarketplaceSkill[];
  hasMore: boolean;
  page: number;
}

interface MarketplaceAuditEnrichment {
  socketOverall?: number;
  snykRisk?: string;
  geminiVerdict?: string;
  auditTitle?: string;
}

interface RawAuditSkill {
  source: string;
  skillId: string;
  name: string;
  agentTrustHub?: {
    result?: {
      gemini_analysis?: {
        verdict?: string;
        summary?: string;
      };
    };
  };
  socket?: {
    result?: {
      score?: {
        overall?: number;
      };
    };
  };
  snyk?: {
    result?: {
      overall_risk_level?: string;
      summary?: string;
    };
  };
}

const CACHE_KEY_MARKETPLACE = "cachedMarketplaceSkills";
const CACHE_KEY_INSTALLED = "cachedInstalledSkills";
const CACHE_KEY_SKILL_SOURCES = "skillSourceMapping";
const CACHE_TTL_MS = 5 * 60 * 1000;

export class SkillsSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentSkillsView";
  private static readonly SEARCH_PAGE_SIZE = 50;
  private static readonly FIRST_PAGE = 0;
  private static readonly MARKETPLACE_CACHE_VERSION = 3;
  private static readonly ALL_TIME_ENDPOINT = "https://skills.sh/api/skills/all-time";
  private static readonly TRENDING_ENDPOINT = "https://skills.sh/api/skills/trending";
  private static readonly HOT_ENDPOINT = "https://skills.sh/api/skills/hot";
  private static readonly AUDITS_ENDPOINT = "https://skills.sh/api/audits";
  private static readonly OFFICIAL_PAGE_URL = "https://skills.sh/official";
  private static readonly MAX_AUDIT_PAGES_PER_PASS = 5;

  private readonly _context: vscode.ExtensionContext;
  private _view?: vscode.WebviewView;
  private _installer: SkillInstaller;
  private _installedSkills: Skill[] = [];
  private _marketplaceSkills: MarketplaceSkill[] = [];
  private _isLoadingMarketplace = false;
  private _isLoadingMore = false;
  private _marketplaceError: string | null = null;
  private _hasMore = false;
  private _currentPage = SkillsSidebarProvider.FIRST_PAGE;
  private _searchQuery = "";
  private _isSearching = false;
  private _activePanel: "installed" | "marketplace" = "installed";
  private _activeMarketplaceFeed: MarketplaceFeed = "all-time";
  private _installedScrollTop = 0;
  private _marketplaceScrollTop = 0;
  private _webviewReady = false;
  private _marketplaceCacheTimestamp = 0;
  private _browseFeedCache = SkillsSidebarProvider._createEmptyFeedCache();
  private _feedPreloadPromises = new Map<MarketplaceFeed, Promise<void>>();
  private _feedWarmupPromise?: Promise<void>;
  private _searchRequestId = 0;
  private _browseRequestId = 0;
  private _isCheckingUpdates = false;
  private _skillsWithUpdates = new Set<string>();
  private _isUpdatingAllSkills = false;
  private _officialSources?: Set<string>;
  private _officialSourcesPromise?: Promise<Set<string>>;
  private _auditEnrichments = new Map<string, MarketplaceAuditEnrichment>();
  private _auditNextPage = SkillsSidebarProvider.FIRST_PAGE;
  private _auditHasMore = true;

  private static _createEmptyFeedCache(): Record<MarketplaceFeed, CachedFeedState> {
    return {
      "all-time": {
        skills: [],
        hasMore: false,
        page: SkillsSidebarProvider.FIRST_PAGE,
      },
      trending: {
        skills: [],
        hasMore: false,
        page: SkillsSidebarProvider.FIRST_PAGE,
      },
      hot: {
        skills: [],
        hasMore: false,
        page: SkillsSidebarProvider.FIRST_PAGE,
      },
    };
  }

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
    this._updateInstalledPanelContext();
    this._webviewReady = false;
    webviewView.webview.html = this._getHtmlContent(webviewView.webview);
    
    this._refreshInstalledSkills().then(() => {
      this._updateWebview();
      if (this._activePanel === "installed") {
        void this._checkForUpdates();
      }
    });
    void this._refreshMarketplaceView();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._refreshInstalledSkills().then(() => {
          this._updateWebview();
          if (this._activePanel === "installed") {
            void this._checkForUpdates();
          }
        });
        void this._refreshMarketplaceView();
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
          await this._deleteSkill(message.path, message.name, message.level, message.mode);
          break;
        case "refresh":
          await this._refreshInstalledSkills();
          await this._refreshMarketplaceView(true);
          break;
        case "openExternal":
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case "openUrl":
          vscode.commands.executeCommand('simpleBrowser.show', message.url);
          break;
        case "setSearchQuery":
          this._searchQuery = message.query || "";
          break;
        case "search":
          await this._handleSearch(message.query);
          break;
        case "checkUpdates":
          await this._checkForUpdates();
          break;
        case "updateAllSkills":
          await this._updateAllSkills();
          break;
        case "loadMore":
          await this._loadMoreSkills();
          break;
        case "setActivePanel":
          this._activePanel = message.panel;
          this._updateInstalledPanelContext();
          if (this._activePanel === "installed") {
            void this._checkForUpdates();
          }
          break;
        case "setMarketplaceFeed":
          this._activeMarketplaceFeed = message.feed;
          void this._persistMarketplaceCache();
          if (this._activePanel === "marketplace" && !this._searchQuery.trim()) {
            await this._showBrowseFeed(this._activeMarketplaceFeed);
          } else {
            this._updateWebview();
          }
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
    await this._refreshMarketplaceView(true);
  }

  public async checkForUpdates() {
    await this._checkForUpdates(true);
  }

  public async updateAllSkills() {
    await this._updateAllSkills();
  }

  private _loadFromCache() {
    const cachedInstalled = this._context.globalState.get<CachedData<Skill[]>>(CACHE_KEY_INSTALLED);
    if (cachedInstalled?.data) {
      this._installedSkills = cachedInstalled.data;
    }

    const cachedMarketplace = this._context.globalState.get<CachedData<CachedMarketplaceData>>(CACHE_KEY_MARKETPLACE);
    if (cachedMarketplace?.data?.feeds) {
      const isCompatibleCache =
        cachedMarketplace.data.version === SkillsSidebarProvider.MARKETPLACE_CACHE_VERSION;
      if (!isCompatibleCache) {
        void this._context.globalState.update(CACHE_KEY_MARKETPLACE, undefined);
        return;
      }

      this._marketplaceCacheTimestamp = cachedMarketplace.timestamp;
      this._activeMarketplaceFeed = cachedMarketplace.data.activeFeed || "all-time";
      this._browseFeedCache = SkillsSidebarProvider._createEmptyFeedCache();

      for (const feed of Object.keys(this._browseFeedCache) as MarketplaceFeed[]) {
        const cachedFeed = cachedMarketplace.data.feeds[feed];
        if (cachedFeed?.skills) {
          this._browseFeedCache[feed] = {
            skills: cachedFeed.skills,
            hasMore: Boolean(cachedFeed.hasMore),
            page: Number.isFinite(cachedFeed.page)
              ? cachedFeed.page
              : SkillsSidebarProvider.FIRST_PAGE,
          };
        }
      }

      const activeFeed = this._browseFeedCache[this._activeMarketplaceFeed];
      if (activeFeed.skills.length > 0) {
        this._applyBrowseState(activeFeed.skills, activeFeed.hasMore, activeFeed.page);
      }
    }
  }

  private async _refreshInstalledSkills() {
    const skills = await scanAllSkills();
    // Merge saved marketplace id for skills
    const idMapping = this._context.globalState.get<Record<string, string>>(CACHE_KEY_SKILL_SOURCES, {});
    this._installedSkills = skills.map(skill => ({
      ...skill,
      marketplaceId: idMapping[skill.name],
      updateAvailable: this._skillsWithUpdates.has(skill.name)
    }));

    if (this._installedSkills.length === 0 && this._activePanel === "installed") {
      this._activePanel = "marketplace";
      this._updateInstalledPanelContext();
    }

    this._context.globalState.update(CACHE_KEY_INSTALLED, {
      data: this._installedSkills,
      timestamp: Date.now()
    } as CachedData<Skill[]>);
  }

  private async _refreshMarketplaceView(forceRefresh = false) {
    if (this._activePanel === "marketplace" && this._searchQuery.trim()) {
      await this._handleSearch(this._searchQuery);
      return;
    }

    await this._showBrowseFeed(this._activeMarketplaceFeed, { forceRefresh });
  }

  private async _showBrowseFeed(
    feed: MarketplaceFeed,
    options: { forceRefresh?: boolean } = {},
  ) {
    const cached = this._browseFeedCache[feed];
    const isCacheFresh =
      cached.skills.length > 0 &&
      (Date.now() - this._marketplaceCacheTimestamp) < CACHE_TTL_MS;

    if (cached.skills.length > 0 && !options.forceRefresh) {
      this._marketplaceError = null;
      this._isLoadingMarketplace = false;
      this._applyBrowseState(cached.skills, cached.hasMore, cached.page);
      this._updateWebview();
      this._scheduleBackgroundFeedWarmup(feed);

      if (!isCacheFresh) {
        void this._fetchMarketplaceSkills({ feed, forceRefresh: true, background: true });
      }
      return;
    }

    if (!options.forceRefresh) {
      const pendingPreload = this._feedPreloadPromises.get(feed);
      if (pendingPreload) {
        this._isLoadingMarketplace = true;
        this._marketplaceError = null;
        this._updateWebview();
        await pendingPreload;

        const warmedFeed = this._browseFeedCache[feed];
        if (warmedFeed.skills.length > 0) {
          this._isLoadingMarketplace = false;
          this._marketplaceError = null;
          this._applyBrowseState(
            warmedFeed.skills,
            warmedFeed.hasMore,
            warmedFeed.page,
          );
          this._updateWebview();
          return;
        }
      }
    }

    await this._fetchMarketplaceSkills({
      feed,
      forceRefresh: Boolean(options.forceRefresh),
    });
  }

  private async _fetchMarketplaceSkills(
    options: {
      feed?: MarketplaceFeed;
      forceRefresh?: boolean;
      background?: boolean;
    } = {},
  ) {
    const feed = options.feed || this._activeMarketplaceFeed;
    const requestId = ++this._browseRequestId;
    const shouldApplyNow =
      this._shouldApplyBrowseNow() && this._activeMarketplaceFeed === feed;
    const shouldShowLoading = shouldApplyNow && !options.background;

    if (shouldShowLoading) {
      this._isLoadingMarketplace = true;
      this._marketplaceError = null;
      this._updateWebview();
    }

    try {
      const response = await this._fetchFeedPage(feed, SkillsSidebarProvider.FIRST_PAGE);
      if (requestId !== this._browseRequestId) {
        return;
      }

      const enrichedSkills = await this._resolveMarketplaceSkillsForView(
        response.skills,
      );
      if (requestId !== this._browseRequestId) {
        return;
      }

      this._updateBrowseCache(feed, enrichedSkills, response.hasMore, response.page);
      await this._persistMarketplaceCache();

      if (shouldApplyNow) {
        this._marketplaceError =
          !options.background && enrichedSkills.length === 0
            ? "No skills found in response. Try refreshing."
            : null;
        this._applyBrowseState(enrichedSkills, response.hasMore, response.page);
      }

      this._scheduleBackgroundFeedWarmup(feed);
    } catch (error: any) {
      if (requestId !== this._browseRequestId) {
        return;
      }
      if (shouldApplyNow && !options.background) {
        this._marketplaceError = `Failed to load: ${error?.message || error}`;
      }
    } finally {
      if (requestId === this._browseRequestId && shouldApplyNow) {
        this._isLoadingMarketplace = false;
        this._updateWebview();
      }
    }
  }

  private async _handleSearch(query: string) {
    const nextQuery = String(query || "");
    const trimmedQuery = nextQuery.trim();
    this._searchQuery = nextQuery;
    this._activePanel = "marketplace";
    this._updateInstalledPanelContext();
    const requestId = ++this._searchRequestId;

    if (!trimmedQuery) {
      this._isSearching = false;
      this._isLoadingMarketplace = false;
      this._marketplaceError = null;
      await this._showBrowseFeed(this._activeMarketplaceFeed);
      return;
    }

    this._isSearching = true;
    this._isLoadingMarketplace = true;
    this._marketplaceError = null;
    this._updateWebview();

    try {
      const url = `https://skills.sh/api/search?q=${encodeURIComponent(trimmedQuery)}&limit=${SkillsSidebarProvider.SEARCH_PAGE_SIZE}`;
      const response = await this._httpGetJson<SkillsSearchResponse>(url);
      if (requestId !== this._searchRequestId) {
        return;
      }

      const enrichedSkills = await this._resolveMarketplaceSkillsForView(
        response.skills.map((skill) => this._toMarketplaceSkill(skill)),
      );
      if (requestId !== this._searchRequestId) {
        return;
      }

      this._marketplaceSkills = enrichedSkills;
      this._hasMore = false;
      this._currentPage = SkillsSidebarProvider.FIRST_PAGE;
      this._marketplaceError = null;
    } catch (error: any) {
      if (requestId !== this._searchRequestId) {
        return;
      }
      this._marketplaceError = `Search failed: ${error?.message || error}`;
    } finally {
      if (requestId === this._searchRequestId) {
        this._isLoadingMarketplace = false;
        this._updateWebview();
      }
    }
  }

  private async _loadMoreSkills() {
    if (
      this._isSearching ||
      this._isLoadingMore ||
      this._isLoadingMarketplace ||
      !this._hasMore ||
      this._searchQuery.trim()
    ) {
      return;
    }

    const activeFeed = this._activeMarketplaceFeed;
    const requestId = this._browseRequestId;
    this._isLoadingMore = true;
    this._updateWebview();

    try {
      const nextPage = this._currentPage + 1;
      const response = await this._fetchFeedPage(activeFeed, nextPage);

      if (
        requestId !== this._browseRequestId ||
        this._searchQuery.trim() ||
        this._activeMarketplaceFeed !== activeFeed
      ) {
        return;
      }

      const enrichedPageSkills = await this._resolveMarketplaceSkillsForView(
        response.skills,
      );
      if (
        requestId !== this._browseRequestId ||
        this._searchQuery.trim() ||
        this._activeMarketplaceFeed !== activeFeed
      ) {
        return;
      }

      const mergedSkills = this._dedupeMarketplaceSkills([
        ...this._marketplaceSkills,
        ...enrichedPageSkills,
      ]);

      this._marketplaceSkills = mergedSkills;
      this._hasMore = Boolean(response.hasMore);
      this._currentPage = response.page;
      this._marketplaceError = null;
      this._updateBrowseCache(
        activeFeed,
        this._marketplaceSkills,
        this._hasMore,
        this._currentPage,
      );
      await this._persistMarketplaceCache();
    } catch (error: any) {
      this._marketplaceError = `Failed to load more: ${error?.message || error}`;
    } finally {
      this._isLoadingMore = false;
      this._updateWebview();
    }
  }

  private async _checkForUpdates(showNotifications = false) {
    if (this._isCheckingUpdates) return;
    this._isCheckingUpdates = true;
    this._updateWebview();
    if (showNotifications) {
      vscode.window.showInformationMessage("Checking skill updates...");
    }

    try {
      const output = await this._runSkillsCheckCommand();
      const updates = this._parseUpdatesFromCheckOutput(output);
      this._skillsWithUpdates = updates;
      this._installedSkills = this._installedSkills.map((skill) => ({
        ...skill,
        updateAvailable: updates.has(skill.name),
      }));
      this._updateWebview();
      if (showNotifications) {
        const count = updates.size;
        vscode.window.showInformationMessage(
          count > 0
            ? `${count} skill update${count === 1 ? "" : "s"} available.`
            : "All skills are up to date.",
        );
      }
    } catch {
      // Keep Installed view responsive even if check fails.
      if (showNotifications) {
        vscode.window.showErrorMessage("Failed to check skill updates.");
      }
    } finally {
      this._isCheckingUpdates = false;
      this._updateWebview();
    }
  }

  private async _updateAllSkills() {
    if (this._isUpdatingAllSkills) return;
    this._isUpdatingAllSkills = true;
    this._updateWebview();
    vscode.window.showInformationMessage("Updating all skills...");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const env = {
      ...process.env,
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("npx", ["-y", "skills", "update"], {
          cwd: workspaceRoot,
          shell: true,
          env,
        });

        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`Update failed with code ${code}`));
        });
      });

      await this._refreshInstalledSkills();
      await this._checkForUpdates(false);
      vscode.window.showInformationMessage("Skills updated.");
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to update skills: ${error?.message || error}`);
    } finally {
      this._isUpdatingAllSkills = false;
      this._updateWebview();
    }
  }

  private _updateInstalledPanelContext() {
    void vscode.commands.executeCommand(
      "setContext",
      "agentSkills.installedPanelActive",
      this._activePanel === "installed",
    );
  }

  private async _runSkillsCheckCommand(): Promise<string> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const env = {
      ...process.env,
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
    };

    return new Promise((resolve, reject) => {
      const child = spawn("npx", ["-y", "skills", "check"], {
        cwd: workspaceRoot,
        shell: true,
        env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", () => {
        resolve(stdout || stderr);
      });
    });
  }

  private _parseUpdatesFromCheckOutput(output: string): Set<string> {
    const text = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    const updates = new Set<string>();
    const matches = text.matchAll(/^\s*↑\s+(.+)$/gm);
    for (const match of matches) {
      const name = match[1]?.trim();
      if (name) updates.add(name);
    }
    return updates;
  }

  private async _persistMarketplaceCache() {
    this._marketplaceCacheTimestamp = Date.now();
    await this._context.globalState.update(CACHE_KEY_MARKETPLACE, {
      data: {
        version: SkillsSidebarProvider.MARKETPLACE_CACHE_VERSION,
        activeFeed: this._activeMarketplaceFeed,
        feeds: this._browseFeedCache,
      },
      timestamp: this._marketplaceCacheTimestamp,
    } as CachedData<CachedMarketplaceData>);
  }

  private async _fetchFeedPage(
    feed: MarketplaceFeed,
    page: number,
  ): Promise<CachedFeedState> {
    const endpoint = this._getFeedEndpoint(feed);
    const payload = await this._httpGetJson<MarketplaceFeedResponse<RawMarketplaceSkill>>(
      `${endpoint}/${page}`,
    );

    return {
      skills: payload.skills.map((skill) => this._toMarketplaceSkill(skill)),
      hasMore: Boolean(payload.hasMore),
      page: Number.isFinite(payload.page) ? payload.page : page,
    };
  }

  private _getFeedEndpoint(feed: MarketplaceFeed): string {
    switch (feed) {
      case "trending":
        return SkillsSidebarProvider.TRENDING_ENDPOINT;
      case "hot":
        return SkillsSidebarProvider.HOT_ENDPOINT;
      case "all-time":
      default:
        return SkillsSidebarProvider.ALL_TIME_ENDPOINT;
    }
  }

  private _toMarketplaceSkill(skill: RawMarketplaceSkill | MarketplaceSkill): MarketplaceSkill {
    return {
      id: skill.id || this._makeMarketplaceKey(skill),
      skillId: skill.skillId,
      name: skill.name,
      installs: skill.installs,
      source: skill.source,
      installsYesterday: skill.installsYesterday,
      change: skill.change,
      official: skill.official,
      socketOverall: skill.socketOverall,
      snykRisk: skill.snykRisk,
      geminiVerdict: skill.geminiVerdict,
      auditTitle: skill.auditTitle,
    };
  }

  private _dedupeMarketplaceSkills(skills: MarketplaceSkill[]): MarketplaceSkill[] {
    const seen = new Set<string>();
    return skills.filter((skill) => {
      const key = skill.id || this._makeMarketplaceKey(skill);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private async _resolveMarketplaceSkillsForView(
    skills: MarketplaceSkill[],
  ): Promise<MarketplaceSkill[]> {
    if (skills.length === 0) {
      return skills;
    }

    const officialPromise = this._ensureOfficialSources().catch(() => undefined);
    await this._bulkEnrichAuditsForSkills(skills);

    const missingSkills = skills.filter(
      (skill) => !this._skillHasAuditData(skill),
    );

    if (missingSkills.length > 0) {
      await this._fetchFallbackAuditsForSkills(missingSkills);
    }

    await officialPromise;
    return this._enrichSkills(skills);
  }

  private _enrichSkills(skills: MarketplaceSkill[]): MarketplaceSkill[] {
    return skills.map((skill) => ({
      ...skill,
      official: skill.official || this._officialSources?.has(skill.source) || false,
      ...this._auditEnrichments.get(this._makeMarketplaceKey(skill)),
    }));
  }

  private _skillHasAuditData(skill: MarketplaceSkill) {
    const enrichment = this._auditEnrichments.get(this._makeMarketplaceKey(skill));
    return Boolean(
      enrichment?.socketOverall ??
        enrichment?.snykRisk ??
        enrichment?.geminiVerdict ??
        skill.socketOverall ??
        skill.snykRisk ??
        skill.geminiVerdict,
    );
  }

  private async _bulkEnrichAuditsForSkills(skills: MarketplaceSkill[]) {
    const missingKeys = new Set(
      skills
        .filter((skill) => !this._skillHasAuditData(skill))
        .map((skill) => this._makeMarketplaceKey(skill)),
    );

    let pagesFetched = 0;

    while (
      missingKeys.size > 0 &&
      this._auditHasMore &&
      pagesFetched < SkillsSidebarProvider.MAX_AUDIT_PAGES_PER_PASS
    ) {
      const page = this._auditNextPage;
      const response = await this._httpGetJson<MarketplaceFeedResponse<RawAuditSkill>>(
        `${SkillsSidebarProvider.AUDITS_ENDPOINT}/${page}`,
      );

      this._auditNextPage =
        (Number.isFinite(response.page) ? response.page : page) + 1;
      this._auditHasMore = Boolean(response.hasMore);
      this._applyAuditEnrichments(response.skills);
      pagesFetched += 1;

      for (const auditSkill of response.skills) {
        missingKeys.delete(this._makeMarketplaceKey(auditSkill));
      }
    }
  }

  private async _fetchFallbackAuditsForSkills(skills: MarketplaceSkill[]) {
    const uniqueSkills = this._dedupeMarketplaceSkills(skills).filter(
      (skill) => !this._skillHasAuditData(skill),
    );

    if (uniqueSkills.length === 0) {
      return;
    }

    const results = await Promise.all(
      uniqueSkills.map(async (skill) => ({
        key: this._makeMarketplaceKey(skill),
        enrichment: await this._fetchSkillPageAuditEnrichment(skill).catch(
          () => undefined,
        ),
      })),
    );

    for (const { key, enrichment } of results) {
      if (!enrichment) {
        continue;
      }

      this._auditEnrichments.set(key, enrichment);
    }
  }

  private _applyAuditEnrichments(skills: RawAuditSkill[]) {
    for (const skill of skills) {
      const socketOverall = skill.socket?.result?.score?.overall;
      const snykRisk = skill.snyk?.result?.overall_risk_level;
      const geminiVerdict = skill.agentTrustHub?.result?.gemini_analysis?.verdict;

      this._auditEnrichments.set(this._makeMarketplaceKey(skill), {
        socketOverall:
          typeof socketOverall === "number"
            ? Number(socketOverall.toFixed(2))
            : undefined,
        snykRisk,
        geminiVerdict,
        auditTitle: this._buildAuditTitle(skill, socketOverall, snykRisk, geminiVerdict),
      });
    }
  }

  private async _fetchSkillPageAuditEnrichment(
    skill: Pick<MarketplaceSkill, "source" | "skillId">,
  ): Promise<MarketplaceAuditEnrichment | undefined> {
    const skillPath = this._buildSkillPagePath(skill);
    const html = await this._httpGet(`https://skills.sh/${skillPath}`);
    const socketStatus = this._extractAuditStatusFromSkillPage(
      html,
      skillPath,
      "socket",
    );
    const snykStatus = this._extractAuditStatusFromSkillPage(
      html,
      skillPath,
      "snyk",
    );
    const geminiStatus = this._extractAuditStatusFromSkillPage(
      html,
      skillPath,
      "agent-trust-hub",
    );

    if (!socketStatus && !snykStatus && !geminiStatus) {
      return undefined;
    }

    return {
      socketOverall: this._mapFallbackStatusToSocketOverall(socketStatus),
      snykRisk: this._mapFallbackStatusToRiskLabel(snykStatus),
      geminiVerdict: this._mapFallbackStatusToRiskLabel(geminiStatus),
      auditTitle: this._buildFallbackAuditTitle(
        socketStatus,
        snykStatus,
        geminiStatus,
      ),
    };
  }

  private _buildSkillPagePath(
    skill: Pick<MarketplaceSkill, "source" | "skillId">,
  ) {
    const sourcePath = skill.source
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${sourcePath}/${encodeURIComponent(skill.skillId)}`;
  }

  private _extractAuditStatusFromSkillPage(
    html: string,
    skillPath: string,
    providerSlug: "socket" | "snyk" | "agent-trust-hub",
  ): "PASS" | "WARN" | "FAIL" | undefined {
    const escapedPath = this._escapeRegExp(
      `/${skillPath}/security/${providerSlug}`,
    );
    const match = html.match(
      new RegExp(`${escapedPath}[\\s\\S]{0,500}?>(Pass|Warn|Fail)<\\/span>`, "i"),
    );
    const status = match?.[1]?.toUpperCase();
    if (status === "PASS" || status === "WARN" || status === "FAIL") {
      return status;
    }
    return undefined;
  }

  private _mapFallbackStatusToSocketOverall(
    status?: "PASS" | "WARN" | "FAIL",
  ): number | undefined {
    switch (status) {
      case "PASS":
        return 0.9;
      case "WARN":
        return 0.65;
      case "FAIL":
        return 0.35;
      default:
        return undefined;
    }
  }

  private _mapFallbackStatusToRiskLabel(
    status?: "PASS" | "WARN" | "FAIL",
  ): string | undefined {
    switch (status) {
      case "PASS":
        return "SAFE";
      case "WARN":
        return "MEDIUM";
      case "FAIL":
        return "HIGH";
      default:
        return undefined;
    }
  }

  private _buildFallbackAuditTitle(
    socketStatus?: "PASS" | "WARN" | "FAIL",
    snykStatus?: "PASS" | "WARN" | "FAIL",
    geminiStatus?: "PASS" | "WARN" | "FAIL",
  ): string | undefined {
    const details: string[] = [];

    if (socketStatus) {
      details.push(`Socket: ${this._formatFallbackAuditStatus(socketStatus)}`);
    }

    if (snykStatus) {
      details.push(`Snyk: ${this._formatFallbackAuditStatus(snykStatus)}`);
    }

    if (geminiStatus) {
      details.push(`Gemini: ${this._formatFallbackAuditStatus(geminiStatus)}`);
    }

    return details.length > 0 ? details.join(" · ") : undefined;
  }

  private _formatFallbackAuditStatus(status: "PASS" | "WARN" | "FAIL") {
    switch (status) {
      case "PASS":
        return "Pass";
      case "WARN":
        return "Warn";
      case "FAIL":
        return "Fail";
    }
  }

  private _escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private _buildAuditTitle(
    skill: RawAuditSkill,
    socketOverall?: number,
    snykRisk?: string,
    geminiVerdict?: string,
  ): string | undefined {
    const details: string[] = [];

    if (typeof socketOverall === "number") {
      details.push(`Socket: ${Math.round(socketOverall * 100)}% overall`);
    }

    if (snykRisk) {
      details.push(`Snyk: ${snykRisk}`);
    }

    if (skill.snyk?.result?.summary) {
      details.push(skill.snyk.result.summary);
    }

    if (geminiVerdict) {
      details.push(`Gemini: ${geminiVerdict}`);
    }

    if (skill.agentTrustHub?.result?.gemini_analysis?.summary) {
      details.push(skill.agentTrustHub.result.gemini_analysis.summary);
    }

    return details.length > 0 ? details.join(" · ") : undefined;
  }

  private async _ensureOfficialSources(): Promise<Set<string>> {
    if (this._officialSources) {
      return this._officialSources;
    }

    if (!this._officialSourcesPromise) {
      this._officialSourcesPromise = this._loadOfficialSources();
    }

    try {
      this._officialSources = await this._officialSourcesPromise;
      return this._officialSources;
    } finally {
      this._officialSourcesPromise = undefined;
    }
  }

  private async _loadOfficialSources(): Promise<Set<string>> {
    const html = await this._httpGet(SkillsSidebarProvider.OFFICIAL_PAGE_URL);
    const normalized = html.replace(/\\"/g, '"');
    const matches = normalized.matchAll(/"repo":"([^"]+\/[^"]+)"/g);
    const officialSources = new Set<string>();

    for (const match of matches) {
      if (match[1]) {
        officialSources.add(match[1]);
      }
    }

    return officialSources;
  }

  private _makeMarketplaceKey(skill: Pick<MarketplaceSkill, "source" | "skillId">) {
    return `${skill.source}/${skill.skillId}`;
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

  private async _deleteSkill(
    skillPath: string,
    name: string,
    _selectedLevel?: SkillLevel,
    _selectedMode?: CompatibilityMode,
  ) {
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

      const uniquePathsToDelete = [...new Set(pathsToDelete)];

      for (const target of uniquePathsToDelete) {
        await this._deleteSkillPath(target);
      }

      this._skillsWithUpdates.delete(name);

      await this._refreshInstalledSkills();
      await this._checkForUpdates();
      this._updateWebview();
      vscode.window.showInformationMessage(`Skill "${name}" deleted.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete skill: ${error}`);
    }
  }

  private async _deleteSkillPath(skillPath: string): Promise<void> {
    const normalizedPath = path.normalize(skillPath);
    const baseName = path.basename(normalizedPath).toLowerCase();
    const isSkillMarkdown = baseName === "skill.md";
    const targetPath = isSkillMarkdown ? path.dirname(normalizedPath) : normalizedPath;

    await fs.promises.rm(targetPath, { recursive: true, force: true });
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
      marketplaceSkills: this._enrichSkills(this._marketplaceSkills),
      isLoadingMarketplace: this._isLoadingMarketplace,
      isLoadingMore: this._isLoadingMore,
      hasMore: this._hasMore,
      marketplaceError: this._marketplaceError,
      searchQuery: this._searchQuery,
      activePanel: this._activePanel,
      activeMarketplaceFeed: this._activeMarketplaceFeed,
      scroll: {
        installed: this._installedScrollTop,
        marketplace: this._marketplaceScrollTop,
      },
    };
  }

  private _applyBrowseState(skills: MarketplaceSkill[], hasMore: boolean, page: number) {
    this._marketplaceSkills = this._enrichSkills(skills);
    this._hasMore = hasMore;
    this._currentPage = page;
  }

  private _updateBrowseCache(
    feed: MarketplaceFeed,
    skills: MarketplaceSkill[],
    hasMore: boolean,
    page: number,
  ) {
    this._browseFeedCache[feed] = {
      skills: this._dedupeMarketplaceSkills(skills.map((skill) => this._toMarketplaceSkill(skill))),
      hasMore,
      page,
    };
  }

  private _scheduleBackgroundFeedWarmup(feed: MarketplaceFeed) {
    if (feed !== "all-time") {
      return;
    }

    if (this._feedWarmupPromise) {
      return;
    }

    this._feedWarmupPromise = (async () => {
      try {
        for (const nextFeed of ["trending", "hot"] as MarketplaceFeed[]) {
          if (this._shouldWarmFeed(nextFeed)) {
            await this._preloadBrowseFeed(nextFeed);
          }
        }
      } finally {
        this._feedWarmupPromise = undefined;
      }
    })();
  }

  private _shouldWarmFeed(feed: MarketplaceFeed) {
    const cached = this._browseFeedCache[feed];
    const isCacheFresh =
      cached.skills.length > 0 &&
      (Date.now() - this._marketplaceCacheTimestamp) < CACHE_TTL_MS;
    return !isCacheFresh;
  }

  private async _preloadBrowseFeed(feed: MarketplaceFeed) {
    if (this._feedPreloadPromises.has(feed)) {
      return this._feedPreloadPromises.get(feed);
    }

    const preloadPromise = (async () => {
      try {
        const response = await this._fetchFeedPage(
          feed,
          SkillsSidebarProvider.FIRST_PAGE,
        );
        const enrichedSkills = await this._resolveMarketplaceSkillsForView(
          response.skills,
        );
        this._updateBrowseCache(feed, enrichedSkills, response.hasMore, response.page);
        await this._persistMarketplaceCache();

        if (
          this._activePanel === "marketplace" &&
          !this._searchQuery.trim() &&
          this._activeMarketplaceFeed === feed
        ) {
          this._marketplaceError = null;
          this._applyBrowseState(enrichedSkills, response.hasMore, response.page);
          this._updateWebview();
        }
      } catch {
        // Ignore warm-cache failures; the tab can still load on demand later.
      } finally {
        this._feedPreloadPromises.delete(feed);
      }
    })();

    this._feedPreloadPromises.set(feed, preloadPromise);
    return preloadPromise;
  }

  private _shouldApplyBrowseNow() {
    return !this._searchQuery.trim();
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
